// SkylineArt from components/site/illustrations.tsx, drawn into #skyline.
// `ground` is where the green strip starts; `trees` are [x, y, scale].
function drawSkyline({ ground, trees }) {
  const tree = (x, y, s) => `
    <rect x="${x - 3 * s}" y="${y}" width="${6 * s}" height="${26 * s}" fill="#6b4a2b" />
    <circle cx="${x}" cy="${y - 6 * s}" r="${22 * s}" fill="#0a9b63" />
    <circle cx="${x - 16 * s}" cy="${y + 4 * s}" r="${16 * s}" fill="#02c27f" />
    <circle cx="${x + 16 * s}" cy="${y + 2 * s}" r="${17 * s}" fill="#0c9f6a" />`;
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("");
  document.getElementById("skyline").innerHTML = `
    <rect x="248" y="96" width="40" height="324" fill="#e0a800" />
    <rect x="40" y="96" width="208" height="324" fill="#ffc501" />
    ${range(11, (i) => `<rect x="40" y="${116 + i * 28}" width="208" height="12" fill="#101b17" />`)}
    <rect x="80" y="54" width="130" height="42" fill="#ff8a4c" />
    <rect x="210" y="54" width="22" height="42" fill="#ed5e3b" />
    <path d="M110 54V14M150 54V26" stroke="#101b17" stroke-width="4" />
    <rect x="300" y="226" width="130" height="194" fill="#ffdbc9" />
    ${range(5, (r) => range(4, (c) => `<rect x="${314 + c * 28}" y="${244 + r * 32}" width="16" height="18" rx="2" fill="#ffb38a" />`))}
    <rect x="1010" y="236" width="130" height="184" fill="#ccf3e5" />
    ${range(5, (r) => `<rect x="1024" y="${254 + r * 32}" width="102" height="14" rx="3" fill="#02c27f" opacity=".55" />`)}
    <path d="M1222 112V20" stroke="#101b17" stroke-width="6" />
    <rect x="1214" y="60" width="16" height="52" fill="#5aa9ee" />
    <rect x="1150" y="112" width="144" height="12" fill="#ffc501" />
    <rect x="1150" y="124" width="144" height="10" fill="#ffb3ce" />
    <rect x="1150" y="134" width="144" height="286" fill="#5aa9ee" />
    <rect x="1294" y="112" width="34" height="308" fill="#101b17" />
    <rect x="1340" y="250" width="110" height="170" fill="#dcd6f9" />
    <rect x="0" y="${ground}" width="1440" height="${420 - ground}" fill="#0c513f" />
    ${trees.map(([x, y, s]) => tree(x, y, s)).join("")}`;
}
