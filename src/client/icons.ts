/** Small robot marking AI players. Drawn on a 24x24 grid. */
const ROBOT = `<title>AI player</title>
  <line x1="12" y1="2.5" x2="12" y2="5.5" class="robot-line"/>
  <circle cx="12" cy="2.3" r="1.7" class="robot-body"/>
  <rect x="1.5" y="9.5" width="2.6" height="5" rx="1.2" class="robot-body"/>
  <rect x="19.9" y="9.5" width="2.6" height="5" rx="1.2" class="robot-body"/>
  <rect x="4" y="5.5" width="16" height="13.5" rx="3.5" class="robot-body"/>
  <circle cx="9" cy="11.2" r="1.9" class="robot-eye"/>
  <circle cx="15" cy="11.2" r="1.9" class="robot-eye"/>
  <rect x="8.5" y="15" width="7" height="1.7" rx="0.85" class="robot-eye"/>`;

/** For inside the table SVG. */
export const robotSvg = (x: number, y: number, size: number) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" class="robot" role="img">${ROBOT}</svg>`;

/** For HTML (results tables, prompts). */
export const robotHtml = (size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" class="robot robot-inline" role="img">${ROBOT}</svg>`;
