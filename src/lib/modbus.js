/**
 * src/lib/modbus.js — 桌面端 Modbus RTU 组帧/解析（客户端组帧路径）
 *
 * 与小程序 utils/modbus-core.js 保持同一套规则：
 *   · CRC16 0xA001、初值 0xFFFF、低字节在前
 *   · FC01/02 读位、FC03/04 读寄存器、FC05/06 单写、FC0F/10 多写
 *   · 异常应答：FC|0x80 + 异常码 + CRC
 *
 * 桌面端把完整 RTU 帧通过 raw.tx 发给 ESP32；固件只做长度/CRC/FC 门禁和字节透传，
 * 不再解析 slave/fc/addr/qty，也不再拼帧。
 */

export function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
    }
  }
  return crc & 0xFFFF;
}

export function buildRtuFrame(pdu) {
  const crc = crc16(pdu);
  return pdu.concat([crc & 0xFF, (crc >> 8) & 0xFF]);
}

export function buildReadFrame(slave, fc, addr, qty) {
  return buildRtuFrame([
    slave & 0xFF, fc & 0xFF,
    (addr >> 8) & 0xFF, addr & 0xFF,
    (qty >> 8) & 0xFF, qty & 0xFF
  ]);
}

export function buildWriteSingleFrame(slave, fc, addr, value) {
  return buildRtuFrame([
    slave & 0xFF, fc & 0xFF,
    (addr >> 8) & 0xFF, addr & 0xFF,
    (value >> 8) & 0xFF, value & 0xFF
  ]);
}

export function buildWriteMultiFrame(slave, fc, addr, values) {
  const data = [];
  for (let i = 0; i < values.length; i++) {
    data.push((values[i] >> 8) & 0xFF, values[i] & 0xFF);
  }
  const qty = values.length;
  return buildRtuFrame([
    slave & 0xFF, fc & 0xFF,
    (addr >> 8) & 0xFF, addr & 0xFF,
    (qty >> 8) & 0xFF, qty & 0xFF,
    data.length & 0xFF
  ].concat(data));
}


export function buildWriteCoilsFrame(slave, addr, bits) {
  const byteCount = Math.ceil(bits.length / 8);
  const data = new Array(byteCount).fill(0);
  bits.forEach((b, i) => { if (b) data[i >> 3] |= (1 << (i & 7)); });
  const qty = bits.length;
  return buildRtuFrame([
    slave & 0xFF, 15,
    (addr >> 8) & 0xFF, addr & 0xFF,
    (qty >> 8) & 0xFF, qty & 0xFF,
    byteCount
  ].concat(data));
}

/** 正常应答长度；异常应答固定 5 字节，调用方按 rx 实际长度再判断。 */
export function expectedResponseLength(fc, qty) {
  if (fc === 1 || fc === 2) return 5 + Math.ceil(qty / 8);
  if (fc === 3 || fc === 4) return 5 + qty * 2;
  if (fc === 5 || fc === 6 || fc === 15 || fc === 16) return 8;
  return 0;
}

export function bytesToHex(bytes, sep) {
  const s = sep === undefined ? ' ' : sep;
  return bytes.map((b) => (b & 0xFF).toString(16).toUpperCase().padStart(2, '0')).join(s);
}

export function hexToBytes(str) {
  const clean = String(str || '').replace(/[^0-9a-fA-F]/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

export function isException(frame, fc) {
  return frame.length >= 5 && frame[1] === ((fc | 0x80) & 0xFF);
}

/**
 * 解析从站应答。
 * 返回 { ok, crcOk, exception, exceptionCode, values?, bits?, address?, value? }
 * ok=false 时看 error：short/crc/exception/echo/fc。
 */
export function parseResponse(frame, fc, qty) {
  if (!frame || frame.length < 5) {
    return { ok: false, error: 'short', crcOk: false, exception: false };
  }
  if (crc16(frame) !== 0) {
    return { ok: false, error: 'crc', crcOk: false, exception: false };
  }
  if (isException(frame, fc)) {
    return {
      ok: false, error: 'exception', crcOk: true,
      exception: true, exceptionCode: frame[2]
    };
  }
  if (frame[1] !== (fc & 0xFF)) {
    return { ok: false, error: 'fc', crcOk: true, exception: false };
  }

  if (fc === 1 || fc === 2) {
    const count = frame[2];
    const bytes = frame.slice(3, 3 + count);
    const bits = [];
    for (let i = 0; i < (qty || count * 8); i++) {
      bits.push((bytes[i >> 3] >> (i & 7)) & 1);
    }
    return { ok: true, crcOk: true, exception: false, bits: bits, byteCount: count };
  }

  if (fc === 3 || fc === 4) {
    const count = frame[2];
    const values = [];
    for (let i = 0; i + 1 < count; i += 2) {
      values.push((frame[3 + i] << 8) | frame[4 + i]);
    }
    return { ok: true, crcOk: true, exception: false, values: values, byteCount: count };
  }

  if (fc === 5 || fc === 6) {
    return {
      ok: true, crcOk: true, exception: false,
      address: (frame[2] << 8) | frame[3],
      value: (frame[4] << 8) | frame[5]
    };
  }

  if (fc === 15 || fc === 16) {
    return {
      ok: true, crcOk: true, exception: false,
      address: (frame[2] << 8) | frame[3],
      quantity: (frame[4] << 8) | frame[5]
    };
  }

  return { ok: false, error: 'unsupported', crcOk: true, exception: false };
}

export const FC_NAME = {
  1: '读线圈', 2: '读离散输入', 3: '读保持寄存器', 4: '读输入寄存器',
  5: '写单线圈', 6: '写单寄存器', 15: '写多线圈', 16: '写多寄存器'
};
