use laploupe_usb_host::{read_frame, Emit, Fault, Host, OpenPort, Request};
use serde_json::json;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn open_native(test_port: &Option<String>) -> Result<Box<dyn laploupe_usb_host::Port>, Fault> {
    let path = if let Some(path) = test_port {
        path.clone()
    } else {
        let ports = serialport::available_ports()
            .map_err(|_| Fault::new("io", "Unable to enumerate serial ports"))?;
        laploupe_usb_host::select_logger(ports)?
    };
    // macOSのPTYはIOSSIOSPEED非対応。試験モードだけ速度ioctlを省く。
    let baud = if test_port.is_some() && cfg!(target_os = "macos") {
        0
    } else {
        115200
    };
    let mut port = serialport::new(path, baud)
        .data_bits(serialport::DataBits::Eight)
        .stop_bits(serialport::StopBits::One)
        .parity(serialport::Parity::None)
        .flow_control(serialport::FlowControl::None)
        .timeout(Duration::from_millis(25))
        .open()
        .map_err(|error| {
            Fault::new(
                if error.kind() == serialport::ErrorKind::Io(io::ErrorKind::PermissionDenied) {
                    "permission-denied"
                } else {
                    "io"
                },
                "Unable to open USB serial port",
            )
        })?;
    if port.write_data_terminal_ready(true).is_err() {
        eprintln!("USB host: DTR unavailable");
    }
    if port.write_request_to_send(true).is_err() {
        eprintln!("USB host: RTS unavailable");
    }
    // Wrapperが所有し、設定済みの同じポートをRead/Write両方に使う。
    struct NativePort(Box<dyn serialport::SerialPort>);
    impl io::Read for NativePort {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            self.0.read(b)
        }
    }
    impl io::Write for NativePort {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    Ok(Box::new(NativePort(port)))
}
fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let test_port: Option<String>;
    #[cfg(feature = "test-port")]
    {
        test_port = if args.len() == 2 && args[0] == "--test-port" {
            Some(args[1].clone())
        } else if args.is_empty() {
            None
        } else {
            return Err(io::Error::other("Invalid arguments"));
        };
    }
    #[cfg(not(feature = "test-port"))]
    {
        if !args.is_empty() {
            return Err(io::Error::other("This build does not accept a test port"));
        }
        test_port = None;
    }
    let output = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let emit: Emit = Arc::new(move |value| {
        let mut output = output.lock().expect("stdout mutex");
        if serde_json::to_writer(&mut *output, &value).is_ok() {
            let _ = output.write_all(b"\n");
            let _ = output.flush();
        }
    });
    emit(json!({"type":"ready", "version":1}));
    let open: OpenPort = Arc::new(move || open_native(&test_port));
    let mut host = Host::new(open, emit.clone());
    let mut stdin = io::stdin().lock();
    while let Some(frame) = read_frame(&mut stdin)? {
        let request: Request = serde_json::from_slice(&frame)
            .map_err(|_| io::Error::other("Invalid request frame"))?;
        host.handle(request);
    }
    Ok(())
}
