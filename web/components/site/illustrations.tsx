/*
 * Flat illustrations in chowdeck.com's style: solid colours, no outlines,
 * simple shapes. All decorative (aria-hidden); the text beside them says
 * what they show.
 */
type ArtProps = { className?: string };

const svgProps = { "aria-hidden": true, xmlns: "http://www.w3.org/2000/svg" } as const;

// A plate of jollof rice and chicken under a magnifying glass.
export function JollofArt({ className }: ArtProps) {
  return (
    <svg viewBox="0 0 400 260" className={className} {...svgProps}>
      <ellipse cx="190" cy="214" rx="168" ry="36" fill="#0c513f" opacity=".18" />
      <ellipse cx="190" cy="200" rx="160" ry="44" fill="#fff" />
      <ellipse cx="190" cy="196" rx="128" ry="30" fill="#f4efe4" />
      <path d="M78 196c8-58 52-92 112-92s104 34 112 92z" fill="#e8642b" />
      <path d="M78 196c4-18 12-34 24-46 6 26 30 40 88 46z" fill="#c94f1d" />
      {[
        [130, 150], [160, 132], [196, 124], [232, 136], [262, 156], [148, 172], [188, 160], [228, 170], [276, 182], [112, 180],
      ].map(([x, y], index) => (
        <ellipse key={index} cx={x} cy={y} rx="6" ry="3" fill="#f7a26b" transform={`rotate(${(index * 37) % 180} ${x} ${y})`} />
      ))}
      {[[176, 146], [214, 150], [246, 172], [140, 162]].map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r="5" fill="#2fa84f" />
      ))}
      <g transform="rotate(-24 250 150)">
        <ellipse cx="250" cy="150" rx="40" ry="26" fill="#9a4a1c" />
        <ellipse cx="244" cy="144" rx="28" ry="15" fill="#b8612b" />
        <rect x="286" y="144" width="34" height="11" rx="5" fill="#fff4d6" />
        <circle cx="322" cy="144" r="8" fill="#fff4d6" />
        <circle cx="322" cy="156" r="8" fill="#fff4d6" />
      </g>
      <path d="M58 92c10-20 30-26 46-14-10 4-14 14-12 26-14-2-26-4-34-12z" fill="#e80b2e" />
      <path d="M100 76c6-6 14-8 20-4-6 2-10 6-12 12z" fill="#2fa84f" />
      <circle cx="318" cy="70" r="44" fill="#fff" opacity=".45" />
      <circle cx="318" cy="70" r="44" fill="none" stroke="#0c513f" strokeWidth="14" />
      <rect x="344" y="104" width="18" height="62" rx="9" fill="#0c513f" transform="rotate(-40 353 135)" />
    </svg>
  );
}

// A woven basket with a drink, bread, greens and a wrapped shawarma.
export function BasketArt({ className }: ArtProps) {
  return (
    <svg viewBox="0 0 400 260" className={className} {...svgProps}>
      <ellipse cx="200" cy="236" rx="150" ry="16" fill="#101b17" opacity=".12" />
      <path d="M118 120a82 82 0 01164 0" fill="none" stroke="#9a5b1e" strokeWidth="12" strokeLinecap="round" />
      <rect x="236" y="38" width="40" height="96" rx="12" fill="#e80b2e" />
      <rect x="246" y="20" width="20" height="26" rx="5" fill="#e80b2e" />
      <rect x="236" y="70" width="40" height="26" fill="#fff" />
      <rect x="244" y="12" width="24" height="10" rx="3" fill="#101b17" />
      <g transform="rotate(-28 160 90)">
        <rect x="104" y="72" width="130" height="36" rx="18" fill="#d99a4e" />
        <path d="M124 80l10 20M150 78l10 22M176 78l10 22M202 80l10 20" stroke="#b97a32" strokeWidth="5" strokeLinecap="round" />
      </g>
      <path d="M184 128l26-92c4-12 22-10 22 2l-6 90z" fill="#e8c08a" />
      <path d="M184 128l12-44 32 4-4 40z" fill="#c9ced6" />
      <path d="M200 52c8-10 22-8 26 4" stroke="#2fa84f" strokeWidth="6" fill="none" strokeLinecap="round" />
      <circle cx="132" cy="122" r="22" fill="#02c27f" />
      <circle cx="112" cy="132" r="18" fill="#0a9b63" />
      <circle cx="152" cy="132" r="16" fill="#0c513f" />
      <path d="M86 126h228l-22 100c-2 8-8 14-16 14H124c-8 0-14-6-16-14z" fill="#ffc501" />
      <path d="M96 158h208M102 190h196M110 220h180" stroke="#e0a800" strokeWidth="8" />
      {[130, 170, 210, 250, 290].map((x) => (
        <path key={x} d={`M${x} 130l-6 104`} stroke="#e0a800" strokeWidth="6" />
      ))}
      <rect x="80" y="118" width="240" height="18" rx="9" fill="#e0a800" />
    </svg>
  );
}

// A receipt with a percent coupon and a map pin.
export function ReceiptArt({ className }: ArtProps) {
  // Ten teeth back along the bottom edge, from x=270 to x=90.
  const zigzag = "l-9 12l-9-12".repeat(10);
  return (
    <svg viewBox="0 0 400 260" className={className} {...svgProps}>
      <g transform="rotate(-6 170 130)">
        <path d={`M90 20h180v196${zigzag}z`} fill="#fff" />
        <rect x="112" y="44" width="90" height="12" rx="6" fill="#101b17" />
        {[76, 100, 124].map((y) => (
          <g key={y}>
            <rect x="112" y={y} width="96" height="9" rx="4.5" fill="#cfd8d4" />
            <rect x="222" y={y} width="28" height="9" rx="4.5" fill="#cfd8d4" />
          </g>
        ))}
        <rect x="112" y="150" width="138" height="4" rx="2" fill="#101b17" opacity=".2" />
        <rect x="112" y="166" width="60" height="14" rx="7" fill="#0c513f" />
        <rect x="200" y="166" width="50" height="14" rx="7" fill="#0c513f" />
      </g>
      <g transform="rotate(14 300 150)">
        <path d="M244 112h104c8 0 14 6 14 14v12a14 14 0 000 28v12c0 8-6 14-14 14H244c-8 0-14-6-14-14v-12a14 14 0 000-28v-12c0-8 6-14 14-14z" fill="#e0457b" />
        <path d="M282 122v84" stroke="#fff" strokeWidth="4" strokeDasharray="8 7" opacity=".6" />
        <circle cx="314" cy="146" r="9" fill="#fff" />
        <circle cx="338" cy="180" r="9" fill="#fff" />
        <path d="M344 140l-36 46" stroke="#fff" strokeWidth="8" strokeLinecap="round" />
      </g>
      <path d="M58 202c-14-18-36-46-36-86 0-20 16-36 36-36s36 16 36 36c0 40-22 68-36 86z" fill="#02c27f" />
      <circle cx="58" cy="116" r="13" fill="#fff" />
    </svg>
  );
}

// A fan of naira notes beside a wallet.
export function NotesArt({ className }: ArtProps) {
  const note = (fill: string, accent: string, rotate: number, dx: number) => (
    <g transform={`rotate(${rotate} 200 200) translate(${dx} 0)`}>
      <rect x="130" y="40" width="140" height="190" rx="12" fill={fill} />
      <rect x="146" y="56" width="108" height="158" rx="8" fill="#fff" opacity=".9" />
      <circle cx="200" cy="120" r="30" fill={accent} />
      <text x="200" y="131" textAnchor="middle" fontSize="32" fontWeight="700" fill="#fff" fontFamily="var(--font-jakarta), sans-serif">
        ₦
      </text>
      <rect x="164" y="170" width="72" height="10" rx="5" fill={accent} opacity=".6" />
      <rect x="176" y="188" width="48" height="10" rx="5" fill={accent} opacity=".4" />
    </g>
  );
  return (
    <svg viewBox="0 0 400 260" className={className} {...svgProps}>
      {note("#ed5e3b", "#ed5e3b", -22, -10)}
      {note("#ff8a4c", "#ff8a4c", 20, 10)}
      {note("#02c27f", "#0c513f", 0, 0)}
      <rect x="90" y="176" width="220" height="80" rx="16" fill="#0c513f" />
      <rect x="90" y="176" width="220" height="22" rx="11" fill="#083b2e" />
      <rect x="262" y="200" width="56" height="36" rx="10" fill="#ffc501" />
      <circle cx="286" cy="218" r="7" fill="#0c513f" />
    </svg>
  );
}

// A delivery rider on a scooter with a green box (drawn in a 400x260 box).
function RiderShapes({ speedLines = true }: { speedLines?: boolean }) {
  return (
    <>
      {speedLines && (
        <path d="M20 120h60M8 150h70M30 180h46" stroke="#fff" strokeWidth="8" strokeLinecap="round" opacity=".8" />
      )}
      <ellipse cx="220" cy="238" rx="150" ry="12" fill="#101b17" opacity=".15" />
      <rect x="96" y="70" width="86" height="80" rx="10" fill="#0c513f" />
      <rect x="96" y="70" width="86" height="20" rx="8" fill="#083b2e" />
      <rect x="126" y="104" width="26" height="26" rx="13" fill="#ffc501" />
      <path d="M110 160h150l40-30h34l-8 22-46 58H130z" fill="#02c27f" />
      <path d="M300 130l-20-62" stroke="#101b17" strokeWidth="10" strokeLinecap="round" />
      <path d="M268 66h34" stroke="#101b17" strokeWidth="10" strokeLinecap="round" />
      <path d="M184 72c4-20 24-30 42-24l14 52-44 14z" fill="#0c9f6a" />
      <path d="M228 98l46-12" stroke="#0c9f6a" strokeWidth="18" strokeLinecap="round" />
      <path d="M196 112l40 6 10 42h-22l-6-26-30 0z" fill="#101b17" />
      <circle cx="226" cy="34" r="26" fill="#ffc501" />
      <path d="M200 34a26 26 0 0152 0z" fill="#e0a800" />
      <rect x="226" y="30" width="30" height="12" rx="6" fill="#101b17" opacity=".8" />
      <circle cx="140" cy="214" r="30" fill="#101b17" />
      <circle cx="140" cy="214" r="12" fill="#cfd8d4" />
      <circle cx="312" cy="214" r="30" fill="#101b17" />
      <circle cx="312" cy="214" r="12" fill="#cfd8d4" />
    </>
  );
}

export function RiderArt({ className }: ArtProps) {
  return (
    <svg viewBox="0 0 400 260" className={className} {...svgProps}>
      <RiderShapes />
    </svg>
  );
}

// Stars and a thumbs-up note.
export function StarsArt({ className }: ArtProps) {
  const star = (cx: number, cy: number, r: number, fill: string) => {
    const points = Array.from({ length: 10 }, (_, index) => {
      const radius = index % 2 === 0 ? r : r * 0.45;
      const angle = (Math.PI / 5) * index - Math.PI / 2;
      return `${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`;
    });
    return <polygon points={points.join(" ")} fill={fill} strokeLinejoin="round" />;
  };
  return (
    <svg viewBox="0 0 400 260" className={className} {...svgProps}>
      {star(120, 150, 54, "#ffc501")}
      {star(210, 110, 74, "#ffc501")}
      {star(300, 150, 54, "#ffc501")}
      {star(210, 110, 30, "#ffd84d")}
      <g transform="rotate(-6 300 60)">
        <rect x="250" y="20" width="120" height="70" rx="20" fill="#fff" />
        <path d="M276 86l-6 22 26-20z" fill="#fff" />
        <path d="M290 72V50l12-18c4-5 12-2 11 4l-3 12h20c6 0 10 5 9 11l-4 14c-1 4-5 7-9 7h-36z" fill="#02c27f" />
        <rect x="278" y="48" width="10" height="26" rx="3" fill="#0c513f" />
      </g>
      <circle cx="60" cy="70" r="8" fill="#ed5e3b" />
      <circle cx="350" cy="220" r="10" fill="#8c77ec" />
      <circle cx="44" cy="220" r="6" fill="#02c27f" />
    </svg>
  );
}

/*
 * The hero's city, after the one on chowdeck.com: a striped yellow tower, a
 * blue tower with a spire, a ChowBot billboard, a buka with a striped awning,
 * trees, and a road with a rider on it.
 */
export function SkylineArt({ className }: ArtProps) {
  const tree = (x: number, s: number) => (
    <g key={x}>
      <rect x={x - 3 * s} y={392 - 26 * s} width={6 * s} height={26 * s} fill="#6b4a2b" />
      <circle cx={x} cy={392 - 32 * s} r={22 * s} fill="#0a9b63" />
      <circle cx={x - 16 * s} cy={392 - 22 * s} r={16 * s} fill="#02c27f" />
      <circle cx={x + 16 * s} cy={392 - 24 * s} r={17 * s} fill="#0c9f6a" />
    </g>
  );
  return (
    <svg viewBox="0 0 1440 460" preserveAspectRatio="xMidYMax slice" className={className} {...svgProps}>
      {/* Striped yellow tower */}
      <rect x="248" y="100" width="40" height="292" fill="#e0a800" />
      <rect x="40" y="100" width="208" height="292" fill="#ffc501" />
      {Array.from({ length: 10 }, (_, index) => (
        <rect key={index} x="40" y={120 + index * 27} width="208" height="12" fill="#101b17" />
      ))}
      <rect x="80" y="58" width="130" height="42" fill="#ff8a4c" />
      <rect x="210" y="58" width="22" height="42" fill="#ed5e3b" />
      <path d="M110 58V18M150 58V30" stroke="#101b17" strokeWidth="4" />
      {/* Peach block */}
      <rect x="300" y="232" width="130" height="160" fill="#ffdbc9" />
      {Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 4 }, (_, col) => (
          <rect key={`${row}-${col}`} x={314 + col * 28} y={250 + row * 34} width="16" height="18" rx="2" fill="#ffb38a" />
        )),
      )}
      {/* Green mid-rise */}
      <rect x="452" y="196" width="140" height="196" fill="#0c513f" />
      {Array.from({ length: 5 }, (_, row) => (
        <rect key={row} x="468" y={214 + row * 34} width="108" height="14" rx="3" fill="#02c27f" opacity=".7" />
      ))}
      {/* ChowBot billboard */}
      <path d="M672 300v92M788 300v92" stroke="#101b17" strokeWidth="10" />
      <rect x="614" y="150" width="232" height="150" rx="14" fill="#fff" stroke="#101b17" strokeWidth="6" />
      <circle cx="680" cy="225" r="46" fill="#0c513f" />
      <g fill="#ffc501">
        <rect x="677" y="186" width="6" height="14" rx="3" />
        <circle cx="680" cy="185" r="6" />
        <rect x="652" y="203" width="56" height="42" rx="12" />
        <path d="M662 244l-6 14 18-10z" />
      </g>
      <g fill="#0c513f">
        <circle cx="668" cy="221" r="5" />
        <circle cx="692" cy="221" r="5" />
        <rect x="670" y="231" width="20" height="4" rx="2" />
      </g>
      <text x="780" y="218" textAnchor="middle" fontSize="34" fontWeight="700" letterSpacing="-1.5" fill="#101b17" fontFamily="var(--font-jakarta), sans-serif">
        Just
      </text>
      <text x="780" y="256" textAnchor="middle" fontSize="34" fontWeight="700" letterSpacing="-1.5" fill="#0c513f" fontFamily="var(--font-jakarta), sans-serif">
        ask.
      </text>
      {/* Buka with a striped awning */}
      <rect x="866" y="292" width="128" height="100" fill="#fff4d6" />
      <rect x="866" y="292" width="128" height="100" fill="none" stroke="#101b17" strokeWidth="4" />
      {Array.from({ length: 8 }, (_, index) => (
        <path
          key={index}
          d={`M${858 + index * 18} 276h18v16a9 9 0 01-18 0z`}
          fill={index % 2 === 0 ? "#e80b2e" : "#fff"}
        />
      ))}
      <rect x="854" y="266" width="152" height="12" rx="4" fill="#101b17" />
      <rect x="884" y="326" width="36" height="66" fill="#0c513f" />
      <rect x="936" y="318" width="40" height="30" rx="4" fill="#99c8ff" />
      {/* Mint block */}
      <rect x="1010" y="236" width="130" height="156" fill="#ccf3e5" />
      {Array.from({ length: 4 }, (_, row) => (
        <rect key={row} x="1024" y={254 + row * 34} width="102" height="14" rx="3" fill="#02c27f" opacity=".55" />
      ))}
      {/* Blue tower with spire */}
      <path d="M1222 112V20" stroke="#101b17" strokeWidth="6" />
      <rect x="1214" y="60" width="16" height="52" fill="#5aa9ee" />
      <rect x="1150" y="112" width="144" height="12" fill="#ffc501" />
      <rect x="1150" y="124" width="144" height="10" fill="#ffb3ce" />
      <rect x="1150" y="134" width="144" height="258" fill="#5aa9ee" />
      <rect x="1294" y="112" width="34" height="280" fill="#101b17" />
      {/* Lilac block */}
      <rect x="1340" y="250" width="110" height="142" fill="#dcd6f9" />
      {[30, 440, 604, 852, 1004, 1146, 1392].map((x, index) => tree(x, index % 2 === 0 ? 1 : 0.85))}
      {/* Road */}
      <rect x="0" y="392" width="1440" height="40" fill="#33413c" />
      {Array.from({ length: 23 }, (_, index) => (
        <rect key={index} x={index * 64 + 8} y="410" width="30" height="4" rx="2" fill="#fff" opacity=".8" />
      ))}
      <rect x="0" y="432" width="1440" height="28" fill="#0c513f" />
      <g transform="translate(470 308) scale(0.46)">
        <RiderShapes speedLines={false} />
      </g>
    </svg>
  );
}

// A flat heart for the footer credit, in the same style as the art above.
export function HeartArt({ className }: ArtProps) {
  return (
    <svg viewBox="0 0 32 28" className={className} {...svgProps}>
      <path d="M16 27C6 19.5 1 14.3 1 8.6 1 4.4 4.3 1 8.4 1c3.1 0 5.9 1.7 7.6 4.4C17.7 2.7 20.5 1 23.6 1 27.7 1 31 4.4 31 8.6c0 5.7-5 10.9-15 18.4z" fill="#e80b2e" />
      <path d="M16 27c4.4-3.3 7.8-6.2 10.2-8.9-3.8 2.4-8.6 4.1-10.2 4.1S9.6 20.5 5.8 18.1C8.2 20.8 11.6 23.7 16 27z" fill="#b8001f" />
      <ellipse cx="8.6" cy="7.4" rx="3.2" ry="2.1" fill="#fff" opacity=".55" transform="rotate(-30 8.6 7.4)" />
    </svg>
  );
}
