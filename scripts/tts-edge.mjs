/**
 * Edge 神经网络语音合成（TTS）小工具。
 *
 * 用途：为演示视频生成中文配音。走 Edge「大声朗读」的合成端点（api.msedgeservices.com），
 * 只需要 `ws`（devDependency）——项目运行时不依赖它。
 *
 *   npm i -D ws          # 首次使用
 *   node scripts/tts-edge.mjs --text "要合成的话" --out out.mp3
 *
 * 端点返回 mp3（24kHz 单声道），可直接交给 ffmpeg 混音。
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import WebSocket from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600n;
/** 与端点要求的浏览器版本绑定；取本机 Edge 主版本即可 */
const CHROMIUM_VERSION = '155.0.4283.62';
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

const HEADERS = {
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 生成 Sec-MS-GEC 令牌：Windows 时间（100ns 刻度）对齐到 5 分钟后与 token 拼接再 SHA-256 */
function secMsGec() {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  const str = `${ticks * 10000000n}${TRUSTED_CLIENT_TOKEN}`;
  return createHash('sha256').update(str, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/**
 * 合成一段中文语音。
 * @param {string} text 文本（纯中文标点即可）
 * @param {{voice?: string, rate?: string, volume?: string, pitch?: string, outPath?: string, timeoutMs?: number}} opts
 * @returns {Promise<Buffer>} mp3 字节
 */
export async function synthesize(text, opts = {}) {
  const voice = opts.voice ?? DEFAULT_VOICE;
  const rate = opts.rate ?? '+0%';
  const volume = opts.volume ?? '+0%';
  const pitch = opts.pitch ?? '+0Hz';
  const timeoutMs = opts.timeoutMs ?? 45000;

  const url =
    'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1' +
    `?Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}` +
    `&TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
    `&ConnectionId=${randomUUID().replace(/-/g, '')}`;

  const ws = new WebSocket(url, { headers: HEADERS });
  const chunks = [];
  let settled = false;

  const mp3 = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`TTS 超时（${timeoutMs}ms）`)), timeoutMs);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    ws.on('open', () => {
      const ts = new Date().toISOString();
      ws.send(
        `X-Timestamp:${ts}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                },
              },
            },
          }),
      );
      ws.send(
        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${ts}Z\r\n` +
          'Path:ssml\r\n\r\n' +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
          `<voice name='${voice}'>` +
          `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody>` +
          `</voice></speak>`,
      );
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (String(data).includes('Path:turn.end')) {
          settled = true;
          clearTimeout(timer);
          ws.close();
          const buf = Buffer.concat(chunks);
          if (!buf.length) reject(new Error('TTS 返回空音频'));
          else resolve(buf);
        }
        return;
      }
      const buf = Buffer.from(data);
      const headerLen = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + headerLen).toString('utf8');
      if (!/Path:\s*audio/i.test(header)) return;
      chunks.push(buf.subarray(2 + headerLen));
    });

    ws.on('error', (e) => fail(new Error(`TTS 连接失败：${e.message}`)));
    ws.on('close', () => {
      if (!settled) fail(new Error(`TTS 连接提前关闭（已收到 ${chunks.length} 个音频块）`));
    });
  });

  if (opts.outPath) {
    mkdirSync(dirname(opts.outPath), { recursive: true });
    writeFileSync(opts.outPath, mp3);
  }
  return mp3;
}

/** CLI 入口 */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/tts-edge.mjs');
if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const text = arg('text', '');
  if (!text) {
    console.error('用法：node scripts/tts-edge.mjs --text "文本" --out out.mp3 [--voice zh-CN-XiaoxiaoNeural] [--rate +0%]');
    process.exit(1);
  }
  const out = arg('out', 'tts.mp3');
  const started = Date.now();
  synthesize(text, { outPath: out, voice: arg('voice', DEFAULT_VOICE), rate: arg('rate', '+0%') })
    .then((buf) => console.log(`OK ${out}  ${(buf.length / 1024).toFixed(0)} KB  ${Date.now() - started}ms`))
    .catch((e) => {
      console.error('FAIL', e.message);
      process.exit(1);
    });
}
