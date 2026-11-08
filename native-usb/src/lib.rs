use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{self, BufRead, Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;

pub const MAX_BYTES: usize = 65536;
pub const MAX_FRAME: usize = 512 * 1024;
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
pub trait Port: Read + Write + Send {}
impl<T: Read + Write + Send> Port for T {}
pub type OpenPort = Arc<dyn Fn() -> Result<Box<dyn Port>, Fault> + Send + Sync>;

#[derive(Debug, Clone)]
pub struct Fault {
    pub code: &'static str,
    pub detail: &'static str,
}
impl Fault {
    pub fn new(code: &'static str, detail: &'static str) -> Self {
        Self { code, detail }
    }
    fn value(&self) -> Value {
        json!({"code": self.code, "detail": self.detail})
    }
}

/// macOSが返すcallout/dial-inの二つの名前を、二台と数えない。
pub fn select_logger(ports: Vec<serialport::SerialPortInfo>) -> Result<String, Fault> {
    let names: Vec<String> = ports
        .into_iter()
        .filter(|p| {
            matches!(&p.port_type,
        serialport::SerialPortType::UsbPort(info) if info.vid == 0x2dcf && info.pid == 0x6002)
        })
        .map(|p| p.port_name)
        .collect();
    let unique: Vec<_> = names
        .iter()
        .filter(|name| {
            !name
                .strip_prefix("/dev/tty.")
                .is_some_and(|suffix| names.contains(&format!("/dev/cu.{suffix}")))
        })
        .collect();
    match unique.as_slice() {
        [] => Err(Fault::new("not-found", "No matching USB logger")),
        [name] => Ok((*name).clone()),
        _ => Err(Fault::new(
            "io",
            "Multiple matching loggers; connect one logger",
        )),
    }
}

fn cancelled() -> Fault {
    Fault::new("cancelled", "Session closed")
}
fn invalid() -> Fault {
    Fault::new("invalid-data", "Invalid USB host request")
}
fn reply(emit: &Emit, id: u64, result: Result<Value, Fault>) {
    emit(match result {
        Ok(value) => json!({"type":"response", "id":id, "result":value}),
        Err(error) => json!({"type":"response", "id":id, "error":error.value()}),
    });
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub method: String,
    pub params: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionParams {
    session: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteParams {
    session: String,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenParams {
    session: String,
    options: Options,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    vendor_id: u16,
    product_id: u16,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
    flow_control: String,
    data_terminal_ready: bool,
    request_to_send: bool,
}
fn valid_session(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
struct PendingWrite {
    id: u64,
    bytes: Vec<u8>,
}
type WriteQueue = Arc<Mutex<Option<mpsc::SyncSender<PendingWrite>>>>;
struct Session {
    name: String,
    stop: Arc<AtomicBool>,
    writes: WriteQueue,
    worker: thread::JoinHandle<()>,
}

/// 1プロセスにUSB接続は一つ。closeはworkerが資源を手放してから応答する。
pub struct Host {
    active: Option<Session>,
    retired: HashSet<String>,
    open: OpenPort,
    emit: Emit,
}
impl Host {
    pub fn new(open: OpenPort, emit: Emit) -> Self {
        Self {
            active: None,
            retired: HashSet::new(),
            open,
            emit,
        }
    }
    pub fn handle(&mut self, request: Request) {
        let id = request.id;
        let result = if id == 0 || id > 9_007_199_254_740_991 {
            Err(invalid())
        } else {
            self.dispatch(request)
        };
        if let Err(error) = result {
            reply(&self.emit, id, Err(error));
        }
    }
    fn dispatch(&mut self, request: Request) -> Result<(), Fault> {
        match request.method.as_str() {
            "serial.open" => {
                let p: OpenParams =
                    serde_json::from_value(request.params).map_err(|_| invalid())?;
                if !valid_session(&p.session) {
                    return Err(invalid());
                }
                if self.retired.contains(&p.session) {
                    return Err(cancelled());
                }
                if self.active.is_some() {
                    return Err(Fault::new("io", "A USB session already owns the host"));
                }
                if self.retired.len() >= 4096 {
                    return Err(Fault::new("io", "Session limit reached; restart host"));
                }
                let o = p.options;
                if o.vendor_id != 0x2dcf
                    || o.product_id != 0x6002
                    || o.baud_rate != 115200
                    || o.data_bits != 8
                    || o.stop_bits != 1
                    || o.parity != "none"
                    || o.flow_control != "none"
                    || !o.data_terminal_ready
                    || !o.request_to_send
                {
                    return Err(invalid());
                }
                let stop = Arc::new(AtomicBool::new(false));
                let (tx, rx) = mpsc::sync_channel(32);
                let writes = Arc::new(Mutex::new(Some(tx)));
                let worker_writes = writes.clone();
                let (open, emit, stopped, name) = (
                    self.open.clone(),
                    self.emit.clone(),
                    stop.clone(),
                    p.session.clone(),
                );
                let worker = thread::spawn(move || {
                    run_session(name, request.id, open, emit, stopped, worker_writes, rx)
                });
                self.active = Some(Session {
                    name: p.session,
                    stop,
                    writes,
                    worker,
                });
            }
            "serial.write" => {
                let p: WriteParams =
                    serde_json::from_value(request.params).map_err(|_| invalid())?;
                if !valid_session(&p.session) || p.bytes.is_empty() || p.bytes.len() > MAX_BYTES {
                    return Err(invalid());
                }
                let s = self
                    .active
                    .as_ref()
                    .filter(|s| s.name == p.session)
                    .ok_or_else(|| {
                        if self.retired.contains(&p.session) {
                            cancelled()
                        } else {
                            Fault::new("not-connected", "No USB session")
                        }
                    })?;
                s.writes
                    .lock()
                    .unwrap()
                    .as_ref()
                    .ok_or_else(cancelled)?
                    .try_send(PendingWrite {
                        id: request.id,
                        bytes: p.bytes,
                    })
                    .map_err(|_| Fault::new("io", "USB write queue unavailable"))?;
            }
            "serial.close" => {
                let p: SessionParams =
                    serde_json::from_value(request.params).map_err(|_| invalid())?;
                if !valid_session(&p.session) {
                    return Err(invalid());
                }
                let owns_port = self.active.as_ref().is_some_and(|s| s.name == p.session);
                if self.retired.len() >= 4096 && !self.retired.contains(&p.session) && !owns_port {
                    return Err(Fault::new("io", "Session limit reached; restart host"));
                }
                self.retired.insert(p.session.clone());
                if self.active.as_ref().is_some_and(|s| s.name == p.session) {
                    self.close_active();
                }
                reply(&self.emit, request.id, Ok(Value::Null));
            }
            _ => {
                return Err(Fault::new(
                    "not-supported",
                    "Only serial commands are supported",
                ))
            }
        }
        Ok(())
    }
    fn close_active(&mut self) {
        if let Some(s) = self.active.take() {
            s.stop.store(true, Ordering::SeqCst);
            s.writes.lock().unwrap().take();
            let _ = s.worker.join();
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.close_active();
    }
}

fn run_session(
    name: String,
    open_id: u64,
    open: OpenPort,
    emit: Emit,
    stop: Arc<AtomicBool>,
    writes: WriteQueue,
    rx: mpsc::Receiver<PendingWrite>,
) {
    let mut port = match open() {
        Ok(port) => port,
        Err(error) => {
            reply(
                &emit,
                open_id,
                Err(if stop.load(Ordering::SeqCst) {
                    cancelled()
                } else {
                    error
                }),
            );
            cancel_writes(&writes, &rx, &emit);
            return;
        }
    };
    if stop.load(Ordering::SeqCst) {
        reply(&emit, open_id, Err(cancelled()));
        drop(port);
        cancel_writes(&writes, &rx, &emit);
        return;
    }
    reply(&emit, open_id, Ok(Value::Null));
    let mut buffer = [0u8; 8192];
    let mut interruptions = 0;
    let mut lost = false;
    while !stop.load(Ordering::SeqCst) && !lost {
        // 一巡の仕事量を制限し、受信と終了を飢餓状態にしない。
        for _ in 0..32 {
            let Ok(write) = rx.try_recv() else { break };
            if stop.load(Ordering::SeqCst) {
                reply(&emit, write.id, Err(cancelled()));
                continue;
            }
            match port.write(&write.bytes) {
                Ok(n) if n > 0 => reply(
                    &emit,
                    write.id,
                    if stop.load(Ordering::SeqCst) {
                        Err(cancelled())
                    } else {
                        Ok(json!({"written":n}))
                    },
                ),
                _ => {
                    reply(&emit, write.id, Err(Fault::new("io", "USB write failed")));
                    lost = true;
                    break;
                }
            }
        }
        if stop.load(Ordering::SeqCst) || lost {
            break;
        }
        let result = port.read(&mut buffer);
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match result {
            Ok(0) => lost = true,
            Ok(n) => {
                interruptions = 0;
                emit(
                    json!({"type":"event", "event":{"type":"serial.data", "session":name,"bytes":&buffer[..n]}}),
                );
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                interruptions += 1;
                emit(
                    json!({"type":"event", "event":{"type":"serial.interrupted", "session":name}}),
                );
                if interruptions >= 5 {
                    lost = true;
                }
            }
            Err(_) => lost = true,
        }
    }
    let report_lost = lost && !stop.load(Ordering::SeqCst);
    writes.lock().unwrap().take();
    if report_lost {
        emit(
            json!({"type":"event", "event":{"type":"serial.lost","session":name,"error":{"code":"io","detail":"USB connection lost"}}}),
        );
    }
    // 資源を先に手放す。close応答はこのthreadのjoin後。
    drop(port);
    cancel_writes(&writes, &rx, &emit);
}
fn cancel_writes(writes: &WriteQueue, rx: &mpsc::Receiver<PendingWrite>, emit: &Emit) {
    writes.lock().unwrap().take();
    for write in rx.try_iter() {
        reply(emit, write.id, Err(cancelled()));
    }
}

/// 改行が来ない壊れた入力でも、メモリを上限以上に増やさない。
pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Truncated frame",
                ))
            };
        }
        let n = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |at| at + 1);
        if frame.len() + n > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Frame too large",
            ));
        }
        let ended = chunk[n - 1] == b'\n';
        frame.extend_from_slice(&chunk[..n]);
        reader.consume(n);
        if ended {
            return Ok(Some(frame));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{atomic::AtomicUsize, Condvar},
        time::Duration,
    };
    #[derive(Clone, Default)]
    struct FakeState {
        input: Arc<Mutex<VecDeque<Vec<u8>>>>,
        sent: Arc<Mutex<Vec<u8>>>,
        dropped: Arc<AtomicBool>,
    }
    struct FakePort(FakeState);
    impl Read for FakePort {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            let chunk = self.0.input.lock().unwrap().pop_front();
            if let Some(mut chunk) = chunk {
                let n = chunk.len().min(output.len());
                output[..n].copy_from_slice(&chunk[..n]);
                if n < chunk.len() {
                    chunk.drain(..n);
                    self.0.input.lock().unwrap().push_front(chunk);
                }
                return Ok(n);
            }
            thread::sleep(Duration::from_millis(1));
            Err(io::ErrorKind::TimedOut.into())
        }
    }
    impl Write for FakePort {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            let n = b.len().min(2);
            self.0.sent.lock().unwrap().extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Drop for FakePort {
        fn drop(&mut self) {
            self.0.dropped.store(true, Ordering::SeqCst);
        }
    }
    fn params(name: &str) -> Value {
        json!({"session":name,"options":{"vendorId":0x2dcf,"productId":0x6002,"baudRate":115200,"dataBits":8,
            "stopBits":1,"parity":"none","flowControl":"none","dataTerminalReady":true,"requestToSend":true}})
    }
    fn command(h: &mut Host, id: u64, method: &str, params: Value) {
        h.handle(Request {
            id,
            method: method.into(),
            params,
        });
    }
    fn receive(rx: &mpsc::Receiver<Value>, id: u64) -> Value {
        loop {
            let v = rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if v["id"] == id {
                return v;
            }
        }
    }
    fn setup(state: FakeState) -> (Host, mpsc::Receiver<Value>) {
        let (tx, rx) = mpsc::channel();
        let emit: Emit = Arc::new(move |v| {
            tx.send(v).unwrap();
        });
        (
            Host::new(
                Arc::new(move || Ok(Box::new(FakePort(state.clone())))),
                emit,
            ),
            rx,
        )
    }
    #[test]
    fn partial_write_and_close_release() {
        let state = FakeState::default();
        let (mut host, rx) = setup(state.clone());
        command(&mut host, 1, "serial.open", params("one"));
        assert!(receive(&rx, 1)["error"].is_null());
        command(
            &mut host,
            2,
            "serial.write",
            json!({"session":"one","bytes":[1,2,3]}),
        );
        assert_eq!(receive(&rx, 2)["result"]["written"], 2);
        command(&mut host, 3, "serial.close", json!({"session":"one"}));
        assert!(receive(&rx, 3)["error"].is_null());
        assert!(state.dropped.load(Ordering::SeqCst));
        assert_eq!(*state.sent.lock().unwrap(), [1, 2]);
        command(&mut host, 4, "serial.open", params("one"));
        assert_eq!(receive(&rx, 4)["error"]["code"], "cancelled");
    }
    #[test]
    fn tombstone_limit_does_not_prevent_closing_the_owned_port() {
        let state = FakeState::default();
        let (mut host, rx) = setup(state.clone());
        command(&mut host, 1, "serial.open", params("one"));
        receive(&rx, 1);
        for n in 0..4096 {
            host.retired.insert(format!("retired-{n}"));
        }
        command(&mut host, 2, "serial.close", json!({"session":"one"}));
        assert!(receive(&rx, 2)["error"].is_null());
        assert!(state.dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn receive_bytes_and_explicit_close_does_not_report_loss() {
        let state = FakeState::default();
        state.input.lock().unwrap().push_back(vec![9, 8, 7]);
        let (mut host, rx) = setup(state);
        command(&mut host, 1, "serial.open", params("one"));
        receive(&rx, 1);
        let data = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(data["event"]["bytes"], json!([9, 8, 7]));
        command(&mut host, 2, "serial.close", json!({"session":"one"}));
        let close = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(close["id"], 2);
    }
    #[test]
    fn close_before_open_is_terminal_and_does_not_open_port() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (tx, rx) = mpsc::channel();
        let mut host = Host::new(
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Err(invalid())
            }),
            Arc::new(move |v| {
                tx.send(v).unwrap();
            }),
        );
        command(&mut host, 1, "serial.close", json!({"session":"one"}));
        receive(&rx, 1);
        command(&mut host, 2, "serial.open", params("one"));
        assert_eq!(receive(&rx, 2)["error"]["code"], "cancelled");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn close_during_open_settles_pending_open_and_write_before_ack() {
        let state = FakeState::default();
        let (tx, rx) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let opening = gate.clone();
        let port_state = state.clone();
        let mut host = Host::new(
            Arc::new(move || {
                let (lock, wake) = &*opening;
                let mut go = lock.lock().unwrap();
                while !*go {
                    go = wake.wait(go).unwrap();
                }
                Ok(Box::new(FakePort(port_state.clone())))
            }),
            Arc::new(move |v| {
                tx.send(v).unwrap();
            }),
        );
        command(&mut host, 1, "serial.open", params("one"));
        command(
            &mut host,
            2,
            "serial.write",
            json!({"session":"one","bytes":[1,2]}),
        );
        let stop = host.active.as_ref().unwrap().stop.clone();
        let thread = thread::spawn(move || {
            command(&mut host, 3, "serial.close", json!({"session":"one"}));
        });
        while !stop.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        assert!(rx.try_recv().is_err());
        *gate.0.lock().unwrap() = true;
        gate.1.notify_one();
        thread.join().unwrap();
        let replies: Vec<_> = rx.try_iter().collect();
        assert_eq!(
            replies
                .iter()
                .map(|v| v["id"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(replies[0]["error"]["code"], "cancelled");
        assert_eq!(replies[1]["error"]["code"], "cancelled");
        assert!(state.dropped.load(Ordering::SeqCst));
        assert!(state.sent.lock().unwrap().is_empty());
    }
    #[test]
    fn invalid_options_bytes_and_foreign_session_are_rejected() {
        let (mut host, rx) = setup(FakeState::default());
        let mut bad = params("one");
        bad["options"]["baudRate"] = json!(9600);
        command(&mut host, 1, "serial.open", bad);
        assert_eq!(receive(&rx, 1)["error"]["code"], "invalid-data");
        command(
            &mut host,
            2,
            "serial.write",
            json!({"session":"one","bytes":[256]}),
        );
        assert_eq!(receive(&rx, 2)["error"]["code"], "invalid-data");
        command(
            &mut host,
            3,
            "serial.write",
            json!({"session":"two","bytes":[1]}),
        );
        assert_eq!(receive(&rx, 3)["error"]["code"], "not-connected");
    }
    #[test]
    fn bounded_frames_reject_truncation_and_oversize() {
        assert_eq!(
            read_frame(&mut io::Cursor::new(b"{}\n")).unwrap(),
            Some(b"{}\n".to_vec())
        );
        assert!(read_frame(&mut io::Cursor::new(b"{}")).is_err());
        assert!(read_frame(&mut io::Cursor::new(vec![b'x'; MAX_FRAME + 1])).is_err());
    }
    #[test]
    fn macos_names_are_one_device_but_two_loggers_are_ambiguous() {
        fn port(name: &str) -> serialport::SerialPortInfo {
            serialport::SerialPortInfo {
                port_name: name.into(),
                port_type: serialport::SerialPortType::UsbPort(serialport::UsbPortInfo {
                    vid: 0x2dcf,
                    pid: 0x6002,
                    serial_number: None,
                    manufacturer: None,
                    product: None,
                }),
            }
        }
        assert_eq!(
            select_logger(vec![port("/dev/tty.usb1"), port("/dev/cu.usb1")]).unwrap(),
            "/dev/cu.usb1"
        );
        assert_eq!(
            select_logger(vec![port("/dev/cu.usb1"), port("/dev/cu.usb2")])
                .unwrap_err()
                .code,
            "io"
        );
        assert_eq!(select_logger(vec![]).unwrap_err().code, "not-found");
    }
}
