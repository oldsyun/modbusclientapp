/**
 * src/lib/presets.js — RTU 参数寄存器模板（与小程序 utils/rtu-presets.js 同源）
 *
 * 桌面工作台的「快速设置 RTU」视图用它生成"模板值 / 设备现值 / 目标值 / 下发帧"对照表。
 * 桌面端不落盘用户模板（模板维护在小程序 tplEdit 页），这里只给三套起步骨架：
 * 现场必须照设备手册核对地址与编码后再写。
 */

export const CODES = {
  baud: {
    name: '波特率 · 0 起顺序码',
    options: [
      { v: 0, label: '1200' }, { v: 1, label: '2400' }, { v: 2, label: '4800' },
      { v: 3, label: '9600' }, { v: 4, label: '19200' }, { v: 5, label: '38400' },
      { v: 6, label: '57600' }, { v: 7, label: '115200' }
    ]
  },
  parity: {
    name: '校验位',
    options: [
      { v: 0, label: '无校验 N' }, { v: 1, label: '奇校验 O' }, { v: 2, label: '偶校验 E' }
    ]
  },
  dataBits: {
    name: '数据位',
    options: [{ v: 0, label: '8 位' }, { v: 1, label: '7 位' }]
  },
  stopBits: {
    name: '停止位',
    options: [{ v: 0, label: '1 位' }, { v: 1, label: '2 位' }]
  }
};

export const PROFILES = [
  {
    id: 'ref-3',
    name: '站号 · 校验 · 波特率',
    note: '从站地址 0x0100、校验位 0x0101、波特率 0x0102（十六进制）。默认示例，请照设备手册核对后再写。',
    items: [
      { name: '从站地址', addr: 0x0100, fc: 6, kind: 'num', min: 1, max: 247, value: 1, slaveSwitch: true },
      { name: '校验位', addr: 0x0101, fc: 6, kind: 'map', code: 'parity', value: 0 },
      { name: '波特率', addr: 0x0102, fc: 6, kind: 'map', code: 'baud', value: 4 }
    ]
  },
  {
    id: 'ref-4',
    name: '4 寄存器参考',
    note: '站号 / 波特率 / 校验 / 数据位 各占一个保持寄存器，地址 1~4。仅作骨架，请按手册改地址。',
    items: [
      { name: '从站地址', addr: 1, fc: 6, kind: 'num', min: 1, max: 247, value: 1, slaveSwitch: true },
      { name: '波特率', addr: 2, fc: 6, kind: 'map', code: 'baud', value: 4 },
      { name: '校验位', addr: 3, fc: 6, kind: 'map', code: 'parity', value: 0 },
      { name: '数据位', addr: 4, fc: 6, kind: 'map', code: 'dataBits', value: 0 }
    ]
  },
  {
    id: 'ref-2',
    name: '站号 + 波特率',
    note: '只动两个寄存器，先把通讯打通时最常用。地址按手册核对。',
    items: [
      { name: '从站地址', addr: 1, fc: 6, kind: 'num', min: 1, max: 247, value: 1, slaveSwitch: true },
      { name: '波特率', addr: 2, fc: 6, kind: 'num', value: 9600 }
    ]
  }
];

/** 一份模板的深拷贝，避免改目标值时污染 PRESETS 常量 */
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function optionsOf(item) {
  const c = item && item.code ? CODES[item.code] : null;
  return c && c.options ? c.options : [];
}

/** 码值 → 可读文字；码表里没有就原样返回，不猜 */
export function labelOf(item, v) {
  const src = optionsOf(item);
  for (let i = 0; i < src.length; i++) {
    if (String(src[i].v) === String(v)) return src[i].label;
  }
  if (item && item.kind === 'hex') return '0x' + (Number(v) || 0).toString(16).toUpperCase();
  return String(v);
}

/** 目标输入 → 要写进寄存器的数值（枚举码直接取 v） */
export function encodeValue(item, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (item && item.kind === 'map') {
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  }
  if (item && item.kind === 'hex') {
    const n = parseInt(s.replace(/^0x/i, ''), 16);
    return isNaN(n) ? 0 : n;
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}
