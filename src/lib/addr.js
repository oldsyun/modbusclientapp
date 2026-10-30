/**
 * src/lib/addr.js — PLC 地址解析（复刻小程序 modscan32._parseAddr / _checkAddr）
 *
 * FC → 显示前缀（与小程序 TAB_PREFIX 对齐）：
 *   1 / 5 / 15  线圈       → ''   （如 00001）
 *   2           离散输入   → '1'  （如 10001）
 *   3 / 6 / 16  保持寄存器 → '4'  （如 40001）
 *   4           输入寄存器 → '3'  （如 30001）
 *
 * 规则：
 *   DEC 模式   "40001" → 协议地址 0（1 基显示：去掉前缀后减 1）；"1" → 0
 *   HEX 模式   "0x0000" 或切到 HEX → 协议地址 0（0 基，与 Modscan 十六进制视图一致）
 */

export const FC_PREFIX = { 1: '', 2: '1', 3: '4', 4: '3', 5: '', 6: '4', 15: '', 16: '4' };

/**
 * 把用户输入的地址解析成 Modbus 协议用的 0 基地址。
 * @param {number} fc  功能码（决定 DEC 模式下的前缀规则）
 * @param {string|number} raw  用户输入，如 "40001" / "0x0000" / "1"
 * @param {'dec'|'hex'} mode   当前进制
 * @returns {{ok:boolean, msg?:string, value:number}}
 */
export function parseModbusAddr(fc, raw, mode) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, msg: '起始地址不能为空', value: 0 };
  const low = s.toLowerCase();

  // 带 0x 一律按十六进制理解，不受当前模式影响
  if (mode === 'hex' || low.startsWith('0x')) {
    const h = low.startsWith('0x') ? low.slice(2) : low;
    const n = parseInt(h, 16);
    if (isNaN(n)) return { ok: false, msg: 'HEX 地址不合法，如 0x0000', value: 0 };
    if (n < 0 || n > 65535) return { ok: false, msg: 'HEX 地址需在 0x0000–0xFFFF', value: n };
    return { ok: true, value: n };
  }

  if (!/^\d+$/.test(s)) {
    return { ok: false, msg: 'DEC 模式只能填数字；十六进制请加 0x 前缀或切 HEX', value: 0 };
  }
  let n = parseInt(s, 10);
  if (n < 1) return { ok: false, msg: '地址从 1 开始（如 40001）', value: n };

  const prefix = FC_PREFIX[fc] != null ? FC_PREFIX[fc] : '';
  let digits = s;
  if (prefix && s.length >= 5 && s.charAt(0) === prefix) digits = s.slice(1); // "40001" → "0001"
  let m = parseInt(digits, 10);
  if (isNaN(m) || m < 1) m = 1;
  return { ok: true, value: m - 1 }; // 1 基 → 0 基
}

/** 一个协议地址在当前模式下怎么显示 */
export function addrLabel(fc, addr, mode) {
  if (mode === 'hex') return '0x' + ((addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'));
  const p = FC_PREFIX[fc] != null ? FC_PREFIX[fc] : '';
  return p + String(addr + 1).padStart(4, '0');
}
