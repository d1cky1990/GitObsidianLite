// 内联自绘 SVG 图标（#61，视觉规范 §8）。
//
// 统一画法：viewBox 0 0 24 24、fill=none、stroke=currentColor、线宽 1.5、
// 圆角端点/连接。同一枚图标只在这里有一份路径定义，组件通过 icon() 复用，
// 不各画一版；不用图标字体、emoji 或外部请求，离线打开仍完整。

export const ICONS = {
  'sidebar-open': '<path d="M4 6h16M4 12h16M4 18h16"/>',
  'close': '<path d="M6 6l12 12M18 6L6 18"/>',
  'search': '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/>',
  'settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2.6v2.2M12 19.2v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6"/>',
  'new-note': '<path d="M12 5v14M5 12h14"/>',
  'back': '<path d="M15 5l-7 7 7 7"/>',
  // 「更多」是唯一用实心圆的一枚：三个水平圆点，视觉居中
  'more': '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
  'chevron-down': '<path d="M5 9l7 7 7-7"/>',
  'folder': '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  'note': '<path d="M6 3h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M15 3v4h4"/>',
  'invalid': '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7"/>',
  'warning': '<path d="M12 3.5 21 19.5H3z"/><path d="M12 9.5v4.5M12 17h.01"/>',
  'error': '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  'success': '<path d="M4 12.5l5 5L20 6.5"/>',
};

export const ICON_NAMES = Object.keys(ICONS);

/** 返回一枚内联 SVG。未知名字返回空串（不画一个坏占位）。 */
export function icon(name, size = 20) {
  const body = ICONS[name];
  if (!body) return '';
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
    ' fill="none" stroke="currentColor" stroke-width="1.5"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    body + '</svg>';
}
