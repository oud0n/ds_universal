import { Unzlib } from 'fflate';

/** 不正なUTF-8は置換文字にする。TextDecoderのないホストでも同じ結果。 */
export function decodeUtf8(bytes:Uint8Array):string {
  const chunks:string[]=[];let text='',i=0,first=true;
  const append=(point:number)=>{if(first){first=false;if(point===0xfeff)return;}text+=String.fromCodePoint(point);if(text.length>=8192){chunks.push(text);text='';}};
  while(i<bytes.length){
    const lead=bytes[i++];
    if(lead<0x80){append(lead);continue;}
    let count:number,point:number,min=0x80,max=0xbf;
    if(lead>=0xc2&&lead<=0xdf){count=1;point=lead&0x1f;}
    else if(lead>=0xe0&&lead<=0xef){count=2;point=lead&0x0f;if(lead===0xe0)min=0xa0;if(lead===0xed)max=0x9f;}
    else if(lead>=0xf0&&lead<=0xf4){count=3;point=lead&7;if(lead===0xf0)min=0x90;if(lead===0xf4)max=0x8f;}
    else{append(0xfffd);continue;}
    let valid=true;
    for(let n=0;n<count;n++){
      const byte=bytes[i];
      if(byte===undefined||byte<min||byte>max){valid=false;break;}
      i++;point=(point<<6)|(byte&0x3f);min=0x80;max=0xbf;
    }
    append(valid?point:0xfffd);
  }
  chunks.push(text);return chunks.join('');
}

/** 途中までしかない記録も、展開できた部分があれば返す。 */
export function inflateZlib(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];let length = 0;
  const inflater = new Unzlib(chunk => { chunks.push(chunk);length += chunk.length; });
  try { inflater.push(bytes, false);inflater.push(new Uint8Array(0), true); } catch (error) { if (!length) throw error; }
  const out = new Uint8Array(length);let at = 0;
  for (const chunk of chunks) { out.set(chunk, at);at += chunk.length; }
  return out;
}


// TextDecoderのlatin1/windows-1252と同じ0x80〜0x9fの対応。
const CP1252 = [8364,129,8218,402,8222,8230,8224,8225,710,8240,352,8249,338,141,381,143,144,8216,8217,8220,8221,8226,8211,8212,732,8482,353,8250,339,157,382,376];
export function decodeWindows1252(bytes: Uint8Array): string {
  let text = '';for (const b of bytes) text += String.fromCharCode(b >= 128 && b < 160 ? CP1252[b - 128] : b);return text;
}
