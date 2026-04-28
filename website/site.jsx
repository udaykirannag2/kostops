/* global React, atlas */
const { useState, useEffect, useRef } = React;
const a = window.atlas;

// ---------- Reusable ----------

const Container = ({ children, style }) => (
  <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 32px', ...style }}>{children}</div>
);

const Eyebrow = ({ children, color = a.c.brand }) => (
  <div style={{
    fontFamily: a.font.mono, fontSize: 11, letterSpacing: '0.14em',
    textTransform: 'uppercase', color, fontWeight: 600,
  }}>{children}</div>
);

const Btn = ({ children, kind = 'primary', icon, ...rest }) => {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    height: 40, padding: '0 18px', borderRadius: a.r.lg,
    fontFamily: a.font.sans, fontSize: 14, fontWeight: 600,
    cursor: 'pointer', border: '1px solid transparent',
    transition: 'all 160ms ease', textDecoration: 'none',
    whiteSpace: 'nowrap',
  };
  const variants = {
    primary: { background: a.c.ink, color: '#fff', borderColor: a.c.ink },
    secondary: { background: '#fff', color: a.c.ink, borderColor: a.c.ruleHi },
    ghost: { background: 'transparent', color: a.c.inkSoft },
    brand: { background: a.c.brand, color: '#fff', borderColor: a.c.brand },
  };
  return (
    <a style={{ ...base, ...variants[kind] }} {...rest}>
      {icon}{children}
    </a>
  );
};

const Pill = ({ children, color = a.c.brand, bg = a.c.brandSoft }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: a.r.pill,
    fontFamily: a.font.mono, fontSize: 11, fontWeight: 600,
    color, background: bg,
    letterSpacing: '0.04em',
  }}>{children}</span>
);

// ---------- Nav ----------

function Nav() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const compact = w < 1100;
  const navItems = compact
    ? [
        { label: 'Product', href: '#' },
        { label: 'Open source', href: 'https://github.com/udaykirannag2/kostops' },
        { label: 'Docs', href: 'https://github.com/udaykirannag2/kostops/blob/main/README.md' },
        { label: 'Demo', href: 'https://www.youtube.com/watch?v=c45qbWEdTcs&feature=youtu.be' },
      ]
    : [
        { label: 'Product', href: '#' },
        { label: 'Open source', href: 'https://github.com/udaykirannag2/kostops' },
        { label: 'Docs', href: 'https://github.com/udaykirannag2/kostops/blob/main/README.md' },
        { label: 'Demo', href: 'https://www.youtube.com/watch?v=c45qbWEdTcs&feature=youtu.be' },
      ];
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 50,
      background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(12px)',
      borderBottom: `1px solid ${a.c.rule}`,
    }}>
      <Container style={{ display: 'flex', alignItems: 'center', height: 64, gap: compact ? 16 : 32 }}>
        <a href="#" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flexShrink: 0 }}>
          <img src="logo-mark.svg" width={28} height={28} alt="" />
          <span style={{ fontFamily: a.font.sans, fontWeight: 700, fontSize: 17, color: a.c.ink, letterSpacing: '-0.01em' }}>KostOps</span>
        </a>
        <nav style={{ display: 'flex', gap: compact ? 18 : 28, marginLeft: compact ? 8 : 16 }}>
          {navItems.map(({ label, href }) => (
            <a key={label} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel={href.startsWith('http') ? 'noopener noreferrer' : undefined} style={{
              fontFamily: a.font.sans, fontSize: 14, fontWeight: 500,
              color: a.c.inkSoft, textDecoration: 'none', whiteSpace: 'nowrap',
            }}>{label}</a>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
          {!compact && (
            <a href="https://github.com/udaykirannag2/kostops" target="_blank" rel="noopener noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontFamily: a.font.sans, fontSize: 13, fontWeight: 500,
              color: a.c.inkSoft, textDecoration: 'none',
              padding: '6px 12px', borderRadius: a.r.md,
              border: `1px solid ${a.c.rule}`,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/></svg>
              <span style={{ fontFamily: a.font.mono, fontSize: 12 }}>2.4k</span>
            </a>
          )}
          {!compact && <Btn kind="secondary" href="#">Contact sales</Btn>}
          <Btn kind="primary" href="https://github.com/udaykirannag2/kostops" target="_blank" rel="noopener noreferrer" icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/></svg>
          }>{compact ? 'Star · 2.4k' : 'Star on GitHub'}</Btn>
        </div>
      </Container>
    </div>
  );
}

// ---------- Hero with live mini-dashboard ----------

function Hero() {
  return (
    <section style={{ padding: '80px 0 100px', position: 'relative', overflow: 'hidden' }}>
      {/* subtle background grid */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: `linear-gradient(${a.c.rule} 1px, transparent 1px), linear-gradient(90deg, ${a.c.rule} 1px, transparent 1px)`,
        backgroundSize: '64px 64px',
        maskImage: 'radial-gradient(ellipse at 50% 0%, black 30%, transparent 70%)',
        opacity: 0.5,
      }} />
      <Container style={{ position: 'relative' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 56, maxWidth: 920, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
            <Pill color={a.c.brand} bg={a.c.brandSoft}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: a.c.brand }} />
              FINOPS · OPEN SOURCE · MIT
            </Pill>
            <h1 style={{
              fontFamily: a.font.sans, fontSize: 76, lineHeight: 1.02,
              letterSpacing: '-0.035em', fontWeight: 700, color: a.c.ink,
              margin: 0, textWrap: 'balance',
            }}>
              The FinOps Agentic platform<br />
              <span style={{ color: a.c.inkDim }}>engineering teams trust.</span>
            </h1>
            <p style={{
              fontFamily: a.font.sans, fontSize: 19, lineHeight: 1.5,
              color: a.c.inkSoft, maxWidth: 640, margin: 0, textWrap: 'pretty',
            }}>
              KostOps finds waste in your AWS bill, ranks it by impact, and helps you fix it —
              with an AI agent that knows your accounts, your workloads, and your commitments.
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              <Btn kind="primary" href="https://github.com/udaykirannag2/kostops" target="_blank" rel="noopener noreferrer" icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/></svg>
              }>Star on GitHub</Btn>
              <Btn kind="secondary" href="https://github.com/udaykirannag2/kostops/blob/main/README.md" target="_blank" rel="noopener noreferrer">Read the docs →</Btn>
            </div>
            <div style={{
              display: 'flex', gap: 24, marginTop: 8,
              fontFamily: a.font.mono, fontSize: 12, color: a.c.inkDim,
              letterSpacing: '0.04em',
            }}>
              <span>★ 2,431 stars</span>
              <span style={{ color: a.c.ruleHi }}>·</span>
              <span>184 contributors</span>
              <span style={{ color: a.c.ruleHi }}>·</span>
              <span>v0.18.2</span>
            </div>
          </div>

          <HeroDashboard />
        </div>
      </Container>
    </section>
  );
}

// Live mini-dashboard with AgentDock teaser
function HeroDashboard() {
  const [agentOpen, setAgentOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const fullText = "Spend on us-east-1 jumped 13.7% this month. Show me the breakdown by service.";

  // Auto-open agent after a beat, then type the question
  useEffect(() => {
    const t1 = setTimeout(() => setAgentOpen(true), 1200);
    return () => clearTimeout(t1);
  }, []);

  useEffect(() => {
    if (!agentOpen) return;
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setTyped(fullText.slice(0, i));
      if (i >= fullText.length) clearInterval(interval);
    }, 28);
    return () => clearInterval(interval);
  }, [agentOpen]);

  return (
    <div style={{
      position: 'relative',
      borderRadius: a.r.xl + 4,
      background: a.c.card,
      border: `1px solid ${a.c.rule}`,
      boxShadow: '0 24px 60px -12px rgba(11,18,32,0.18), 0 4px 12px rgba(11,18,32,0.06)',
      overflow: 'hidden',
      textAlign: 'left',
    }}>
      {/* Browser chrome */}
      <div style={{
        height: 36, background: a.c.bgSunken, borderBottom: `1px solid ${a.c.rule}`,
        display: 'flex', alignItems: 'center', padding: '0 14px', gap: 8,
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map(c => (
            <span key={c} style={{ width: 11, height: 11, borderRadius: 999, background: c }} />
          ))}
        </div>
        <div style={{
          marginLeft: 16, padding: '4px 12px', borderRadius: a.r.md,
          background: '#fff', border: `1px solid ${a.c.rule}`,
          fontFamily: a.font.mono, fontSize: 11, color: a.c.inkDim,
          flex: 1, maxWidth: 360,
        }}>
          🔒 app.kostops.com/billing
        </div>
      </div>

      {/* Dashboard body */}
      <div style={{ display: 'grid', gridTemplateColumns: agentOpen ? '1fr 380px' : '1fr', transition: 'grid-template-columns 280ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
        <div style={{ padding: 24, minWidth: 0 }}>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, fontFamily: a.font.sans, fontSize: 12, color: a.c.inkDim }}>
            <span>Workspace</span><span>›</span>
            <span style={{ color: a.c.ink, fontWeight: 600 }}>Billing summary</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: a.c.ok, fontFamily: a.font.mono, fontSize: 11 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: a.c.ok }} /> SYNCED · 2m ago
            </span>
          </div>

          {/* KPI strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
            <Kpi label="Spend MTD" value="$248,142" delta="+13.7%" deltaColor={a.c.red} />
            <Kpi label="Forecast EOM" value="$268,400" delta="+8.2%" deltaColor={a.c.warn} />
            <Kpi label="Open findings" value="42" delta="12 high" deltaColor={a.c.red} />
            <Kpi label="Realized YTD" value="$184,290" delta="+$23k MoM" deltaColor={a.c.ok} />
          </div>

          {/* Chart */}
          <div style={{
            border: `1px solid ${a.c.rule}`, borderRadius: a.r.lg, padding: 16,
            background: a.c.card,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: a.font.sans, fontSize: 13, fontWeight: 600, color: a.c.ink }}>Daily spend by service</div>
                <div style={{ fontFamily: a.font.mono, fontSize: 11, color: a.c.inkDim, marginTop: 2 }}>LAST 30 DAYS</div>
              </div>
              <div style={{ display: 'flex', gap: 12, fontFamily: a.font.mono, fontSize: 10 }}>
                {[['EC2', a.svc.EC2], ['RDS', a.svc.RDS], ['S3', a.svc.S3], ['Bedrock', a.svc.Bedrock]].map(([k, c]) => (
                  <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: a.c.inkSoft }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} />{k}
                  </span>
                ))}
              </div>
            </div>
            <Chart agentOpen={agentOpen} />
          </div>
        </div>

        {/* AgentDock */}
        <div style={{
          background: a.c.bgSunken, borderLeft: `1px solid ${a.c.rule}`,
          display: agentOpen ? 'flex' : 'none', flexDirection: 'column', minWidth: 0,
        }}>
          <div style={{ padding: '14px 16px', borderBottom: `1px solid ${a.c.rule}`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 24, height: 24, borderRadius: 6,
              background: `linear-gradient(135deg, ${a.c.brand}, ${a.c.teal})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontFamily: a.font.mono, fontSize: 11, fontWeight: 700,
            }}>K</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: a.font.sans, fontSize: 12, fontWeight: 600, color: a.c.ink }}>Kost Agent</div>
              <div style={{ fontFamily: a.font.mono, fontSize: 10, color: a.c.inkDim }}>Billing · all accounts · 30d</div>
            </div>
          </div>
          <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'hidden' }}>
            <ChatBubble side="user">{typed}{typed.length < fullText.length && <span style={{ opacity: 0.5 }}>▎</span>}</ChatBubble>
            {typed === fullText && (
              <ChatBubble side="agent">
                <div style={{ marginBottom: 8 }}>The +13.7% in us-east-1 is driven by three services:</div>
                <div style={{ fontFamily: a.font.mono, fontSize: 11, lineHeight: 1.8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: a.svc.Bedrock }}>● Bedrock</span><span>+$18,420</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: a.svc.EC2 }}>● EC2 (m7i)</span><span>+$8,610</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: a.svc.RDS }}>● RDS (Aurora)</span><span>+$3,140</span></div>
                </div>
                <div style={{ marginTop: 8, color: a.c.inkSoft }}>Bedrock alone explains 60% of the increase. Want me to break it down by model?</div>
              </ChatBubble>
            )}
          </div>
          <div style={{ padding: 12, borderTop: `1px solid ${a.c.rule}`, background: '#fff' }}>
            <div style={{
              border: `1px solid ${a.c.rule}`, borderRadius: a.r.md, padding: '8px 10px',
              fontFamily: a.font.sans, fontSize: 12, color: a.c.inkDim,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ flex: 1 }}>Ask anything…</span>
              <span style={{
                fontFamily: a.font.mono, fontSize: 10,
                padding: '2px 6px', borderRadius: 4, background: a.c.bgSunken,
                color: a.c.inkSoft, border: `1px solid ${a.c.rule}`,
              }}>⌘K</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const Kpi = ({ label, value, delta, deltaColor }) => (
  <div style={{
    border: `1px solid ${a.c.rule}`, borderRadius: a.r.md, padding: 12,
    background: a.c.card,
  }}>
    <div style={{ fontFamily: a.font.mono, fontSize: 10, color: a.c.inkDim, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontFamily: a.font.sans, fontSize: 22, fontWeight: 700, color: a.c.ink, marginTop: 4, fontFeatureSettings: '"tnum"' }}>{value}</div>
    <div style={{ fontFamily: a.font.mono, fontSize: 11, color: deltaColor, marginTop: 2 }}>{delta}</div>
  </div>
);

const ChatBubble = ({ side, children }) => (
  <div style={{
    alignSelf: side === 'user' ? 'flex-end' : 'flex-start',
    maxWidth: '92%',
    padding: '8px 12px', borderRadius: 10,
    background: side === 'user' ? a.c.brand : a.c.card,
    color: side === 'user' ? '#fff' : a.c.ink,
    border: side === 'user' ? 'none' : `1px solid ${a.c.rule}`,
    fontFamily: a.font.sans, fontSize: 12, lineHeight: 1.5,
    boxShadow: side === 'agent' ? a.shadow.sm : 'none',
  }}>{children}</div>
);

// SVG stacked chart with deterministic random
function Chart({ agentOpen }) {
  const days = 30;
  const services = [
    { key: 'EC2', color: a.svc.EC2, base: 4200, var: 800 },
    { key: 'RDS', color: a.svc.RDS, base: 1800, var: 300 },
    { key: 'Bedrock', color: a.svc.Bedrock, base: 600, var: 1400 }, // spike at end
    { key: 'S3', color: a.svc.S3, base: 900, var: 100 },
  ];
  // Deterministic pseudo-random
  const rand = (seed) => {
    const x = Math.sin(seed * 9999) * 10000;
    return x - Math.floor(x);
  };
  const data = [];
  for (let d = 0; d < days; d++) {
    const ramp = d > 20 ? (d - 20) / 9 : 0; // bedrock spike in last 10 days
    const point = services.map((s, i) => {
      const noise = rand(d * 7 + i) * s.var;
      const spike = s.key === 'Bedrock' ? ramp * 1800 : 0;
      return s.base + noise + spike;
    });
    data.push(point);
  }
  const max = Math.max(...data.map(p => p.reduce((a, b) => a + b, 0))) * 1.1;
  const W = 720, H = 180, pad = 0;
  const bw = (W - pad * 2) / days;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 180, display: 'block' }}>
      {/* gridlines */}
      {[0.25, 0.5, 0.75].map(y => (
        <line key={y} x1={0} x2={W} y1={H * y} y2={H * y} stroke={a.c.rule} strokeWidth={1} strokeDasharray="2 4" />
      ))}
      {data.map((point, di) => {
        let acc = 0;
        return (
          <g key={di}>
            {point.map((v, si) => {
              const h = (v / max) * H;
              const y = H - acc - h;
              acc += h;
              return (
                <rect
                  key={si}
                  x={pad + di * bw + 1}
                  y={y}
                  width={bw - 2}
                  height={h}
                  fill={services[si].color}
                  opacity={agentOpen && di < days - 10 ? 0.35 : 1}
                  rx={1}
                />
              );
            })}
          </g>
        );
      })}
      {/* highlight band for last 10 days when agent is open */}
      {agentOpen && (
        <rect x={pad + (days - 10) * bw} y={0} width={10 * bw} height={H} fill={a.c.brand} opacity={0.06} />
      )}
    </svg>
  );
}

// ---------- "Ask anything" agent showcase ----------

function AgentShowcase() {
  const examples = [
    { q: "Why did EBS spend double this week?", scope: "Compute · all accounts" },
    { q: "Which workloads are good Savings Plan candidates?", scope: "Commitments · 90d" },
    { q: "Show me idle RDS instances in production.", scope: "Findings · prod" },
    { q: "What's our forecast vs budget for December?", scope: "Billing · forecast" },
    { q: "Rightsize anything tagged team=growth.", scope: "Compute · tag filter" },
    { q: "How much could we save by switching to Graviton?", scope: "What-if analysis" },
  ];
  return (
    <section style={{ background: a.c.ink, color: '#fff', padding: '120px 0', position: 'relative', overflow: 'hidden' }}>
      <Container>
        <div style={{ maxWidth: 720, marginBottom: 56 }}>
          <Eyebrow color={a.c.brandSoft}>The agent</Eyebrow>
          <h2 style={{
            fontFamily: a.font.sans, fontSize: 56, lineHeight: 1.05,
            letterSpacing: '-0.03em', fontWeight: 700, color: '#fff',
            margin: '14px 0 18px', textWrap: 'balance',
          }}>
            Ask anything. About any account.<br />
            <span style={{ color: '#7d8595' }}>Get the answer, not a dashboard.</span>
          </h2>
          <p style={{ fontFamily: a.font.sans, fontSize: 17, lineHeight: 1.55, color: '#cbd2dd', maxWidth: 580, margin: 0 }}>
            Kost Agent reads every screen you're on. It knows your filters, your accounts, your tag taxonomy,
            and your commitments. Press <kbd style={{ fontFamily: a.font.mono, fontSize: 12, padding: '2px 6px', background: 'rgba(255,255,255,0.1)', borderRadius: 4 }}>⌘K</kbd> from anywhere.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          {examples.map((ex, i) => (
            <div key={i} style={{
              padding: 20, borderRadius: a.r.lg,
              background: 'rgba(255,255,255,0.04)',
              border: `1px solid rgba(255,255,255,0.08)`,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontFamily: a.font.mono, fontSize: 10, color: '#7d8595', letterSpacing: '0.06em' }}>
                {ex.scope.toUpperCase()}
              </div>
              <div style={{ fontFamily: a.font.sans, fontSize: 16, lineHeight: 1.4, color: '#fff', fontWeight: 500 }}>
                "{ex.q}"
              </div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

// ---------- Feature sections ----------

function Features() {
  return (
    <section style={{ padding: '120px 0', background: a.c.bg }}>
      <Container>
        <div style={{ maxWidth: 720, marginBottom: 72 }}>
          <Eyebrow>The platform</Eyebrow>
          <h2 style={{
            fontFamily: a.font.sans, fontSize: 56, lineHeight: 1.05,
            letterSpacing: '-0.03em', fontWeight: 700, color: a.c.ink,
            margin: '14px 0 18px', textWrap: 'balance',
          }}>
            Everything a FinOps team<br />needs. Nothing extra.
          </h2>
          <p style={{ fontFamily: a.font.sans, fontSize: 17, lineHeight: 1.55, color: a.c.inkSoft, maxWidth: 580, margin: 0 }}>
            Three workspaces — Findings, Compute, Commitments — built on a shared model of your AWS spend.
            Tag-aware, account-aware, multi-region.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <FeatureRow
            tag="FINDINGS"
            tagColor={a.c.warn}
            title="Ranked optimization opportunities."
            body="Every untagged resource, idle volume, oversized instance, and unattached IP — surfaced, scored, and assigned. Sort by monthly value. Snooze, ignore, or fix."
            bullets={['42 finding types out of the box', 'Custom rules in YAML', 'Slack & PagerDuty webhooks', 'Owner inference from tags']}
            visual={<FindingsVisual />}
          />
          <FeatureRow
            tag="COMPUTE"
            tagColor={a.c.brand}
            title="Rightsize without guessing."
            body="14-day p95 utilization for every instance. Recommendations grounded in actual workload, not list-price arithmetic. Graviton, Spot, and family-switch suggestions."
            bullets={['EC2 / RDS / EKS / Lambda', 'Per-family utilization view', 'Graviton migration analysis', 'Confidence-scored recommendations']}
            visual={<ComputeVisual />}
            reverse
          />
          <FeatureRow
            tag="COMMITMENTS"
            tagColor={a.c.violet}
            title="Manage Savings Plans like a portfolio."
            body="Coverage forecast, expiry calendar, utilization tracking. Stop overcommitting. Stop leaving money on the table."
            bullets={['Coverage vs target', 'Expiry timeline', 'Recommended next purchase', 'Compute & SageMaker SPs']}
            visual={<CommitmentsVisual />}
          />
        </div>
      </Container>
    </section>
  );
}

const FeatureRow = ({ tag, tagColor, title, body, bullets, visual, reverse }) => (
  <div style={{
    display: 'grid',
    gridTemplateColumns: '1fr 1.3fr',
    gap: 64, alignItems: 'center',
    background: a.c.card, borderRadius: a.r.xl + 4,
    border: `1px solid ${a.c.rule}`, padding: 56,
    direction: reverse ? 'rtl' : 'ltr',
  }}>
    <div style={{ direction: 'ltr' }}>
      <div style={{
        display: 'inline-block', fontFamily: a.font.mono, fontSize: 11,
        fontWeight: 700, color: tagColor, letterSpacing: '0.14em', marginBottom: 16,
      }}>{tag}</div>
      <h3 style={{
        fontFamily: a.font.sans, fontSize: 36, lineHeight: 1.1,
        letterSpacing: '-0.025em', fontWeight: 700, color: a.c.ink,
        margin: '0 0 18px', textWrap: 'balance',
      }}>{title}</h3>
      <p style={{ fontFamily: a.font.sans, fontSize: 16, lineHeight: 1.55, color: a.c.inkSoft, margin: '0 0 24px' }}>{body}</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {bullets.map(b => (
          <li key={b} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            fontFamily: a.font.sans, fontSize: 14, color: a.c.ink,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={tagColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {b}
          </li>
        ))}
      </ul>
    </div>
    <div style={{ direction: 'ltr' }}>{visual}</div>
  </div>
);

// Visuals for feature rows
function FindingsVisual() {
  const items = [
    { sev: 'high', title: 'Idle Aurora cluster · prod-analytics-replica', value: '$4,820', color: a.c.red },
    { sev: 'high', title: 'Untagged EC2 fleet · 28 instances', value: '$3,140', color: a.c.red },
    { sev: 'med', title: 'Oversized m6i.4xlarge · api-gateway', value: '$1,890', color: a.c.warn },
    { sev: 'med', title: 'Unattached EBS gp3 · 412 GB', value: '$680', color: a.c.warn },
    { sev: 'low', title: 'Stale NAT gateway · vpc-stage', value: '$220', color: a.c.inkDim },
  ];
  return (
    <div style={{ borderRadius: a.r.lg, border: `1px solid ${a.c.rule}`, overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${a.c.rule}`, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: a.font.sans, fontSize: 13, fontWeight: 600, color: a.c.ink }}>Open findings</span>
        <Pill color={a.c.warn} bg={a.c.warnSoft}>42 OPEN</Pill>
        <span style={{ marginLeft: 'auto', fontFamily: a.font.mono, fontSize: 11, color: a.c.inkDim }}>SORTED BY $/MO</span>
      </div>
      {items.map((it, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: 'auto 1fr auto',
          alignItems: 'center', gap: 12, padding: '12px 16px',
          borderTop: i > 0 ? `1px solid ${a.c.rule}` : 'none',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: it.color }} />
          <span style={{ fontFamily: a.font.sans, fontSize: 13, color: a.c.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
          <span style={{ fontFamily: a.font.mono, fontSize: 12, fontWeight: 600, color: a.c.ink }}>{it.value}/mo</span>
        </div>
      ))}
    </div>
  );
}

function ComputeVisual() {
  const families = [
    { name: 'm7i', count: 142, util: 78, color: a.c.brand },
    { name: 'r6i', count: 64, util: 62, color: a.c.violet },
    { name: 'c7g', count: 48, util: 84, color: a.c.teal },
    { name: 'm5', count: 28, util: 22, color: a.c.warn, warning: true },
  ];
  return (
    <div style={{ borderRadius: a.r.lg, border: `1px solid ${a.c.rule}`, padding: 20, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div style={{ fontFamily: a.font.sans, fontSize: 13, fontWeight: 600, color: a.c.ink }}>Instance families · p95 utilization</div>
        <div style={{ fontFamily: a.font.mono, fontSize: 11, color: a.c.inkDim }}>14-DAY</div>
      </div>
      {families.map((f, i) => (
        <div key={f.name} style={{ marginBottom: i < families.length - 1 ? 14 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontFamily: a.font.mono, fontSize: 12 }}>
            <span style={{ color: a.c.ink, fontWeight: 600 }}>{f.name}</span>
            <span style={{ color: a.c.inkDim }}>{f.count} instances · <span style={{ color: f.warning ? a.c.warn : a.c.ink, fontWeight: 600 }}>{f.util}%</span></span>
          </div>
          <div style={{ height: 6, borderRadius: 999, background: a.c.bgSunken, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${f.util}%`, background: f.color, borderRadius: 999 }} />
          </div>
          {f.warning && (
            <div style={{
              marginTop: 8, padding: '8px 10px', borderRadius: a.r.md,
              background: a.c.warnSoft, fontFamily: a.font.sans, fontSize: 12, color: a.c.warn,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span>⚠</span> Underutilized — recommend rightsize to m5.large. Est. savings <strong style={{ fontFamily: a.font.mono }}>$1,860/mo</strong>.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CommitmentsVisual() {
  // Coverage line chart
  const points = [62, 65, 68, 71, 74, 76, 78, 80, 82, 81, 83, 85];
  const target = 80;
  const W = 480, H = 200, pad = 24;
  const max = 100;
  const stepX = (W - pad * 2) / (points.length - 1);
  const yFor = v => H - pad - ((v / max) * (H - pad * 2));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * stepX} ${yFor(p)}`).join(' ');
  const areaPath = linePath + ` L ${pad + (points.length - 1) * stepX} ${H - pad} L ${pad} ${H - pad} Z`;

  return (
    <div style={{ borderRadius: a.r.lg, border: `1px solid ${a.c.rule}`, padding: 20, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: a.font.sans, fontSize: 13, fontWeight: 600, color: a.c.ink }}>Coverage forecast</div>
          <div style={{ fontFamily: a.font.mono, fontSize: 11, color: a.c.inkDim, marginTop: 2 }}>NEXT 12 MONTHS · TARGET 80%</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: a.font.sans, fontSize: 22, fontWeight: 700, color: a.c.ok, fontFeatureSettings: '"tnum"' }}>85%</div>
          <div style={{ fontFamily: a.font.mono, fontSize: 10, color: a.c.inkDim }}>EOY PROJECTED</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 200, display: 'block' }}>
        <defs>
          <linearGradient id="commitArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={a.c.violet} stopOpacity="0.18" />
            <stop offset="100%" stopColor={a.c.violet} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* target line */}
        <line x1={pad} x2={W - pad} y1={yFor(target)} y2={yFor(target)} stroke={a.c.ok} strokeWidth={1} strokeDasharray="3 4" />
        <text x={W - pad - 4} y={yFor(target) - 6} textAnchor="end" fontFamily={a.font.mono} fontSize={9} fill={a.c.ok}>TARGET 80%</text>
        <path d={areaPath} fill="url(#commitArea)" />
        <path d={linePath} fill="none" stroke={a.c.violet} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={pad + i * stepX} cy={yFor(p)} r={i === points.length - 1 ? 4 : 0} fill={a.c.violet} stroke="#fff" strokeWidth={2} />
        ))}
      </svg>
    </div>
  );
}

// ---------- OSS section ----------

function OpenSource() {
  return (
    <section style={{ padding: '120px 0', background: a.c.card, borderTop: `1px solid ${a.c.rule}`, borderBottom: `1px solid ${a.c.rule}` }}>
      <Container>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 80, alignItems: 'center' }}>
          <div>
            <Eyebrow color={a.c.ok}>Open source · MIT</Eyebrow>
            <h2 style={{
              fontFamily: a.font.sans, fontSize: 48, lineHeight: 1.05,
              letterSpacing: '-0.03em', fontWeight: 700, color: a.c.ink,
              margin: '14px 0 18px', textWrap: 'balance',
            }}>
              Run it yourself.<br />Read every line.
            </h2>
            <p style={{ fontFamily: a.font.sans, fontSize: 17, lineHeight: 1.55, color: a.c.inkSoft, margin: '0 0 24px', maxWidth: 480 }}>
              KostOps is fully open source. Self-host with a single Docker command, point it at your AWS account,
              and own your FinOps stack — no vendor, no per-seat license, no data leaving your VPC.
            </p>

            {/* GitHub stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
              <StatCard value="2,431" label="STARS" icon="★" />
              <StatCard value="184" label="CONTRIBUTORS" icon="◆" />
              <StatCard value="612" label="FORKS" icon="⑂" />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <Btn kind="primary" href="https://github.com/udaykirannag2/kostops" target="_blank" rel="noopener noreferrer">View on GitHub →</Btn>
              <Btn kind="secondary" href="#">Self-host guide</Btn>
            </div>
          </div>

          <div>
            {/* Install snippet */}
            <div style={{
              borderRadius: a.r.lg, background: a.c.ink,
              padding: 0, overflow: 'hidden',
              boxShadow: '0 16px 40px -12px rgba(11,18,32,0.4)',
            }}>
              <div style={{
                padding: '10px 16px', borderBottom: `1px solid rgba(255,255,255,0.08)`,
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: a.font.mono, fontSize: 11, color: '#7d8595',
              }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['#ff5f57', '#febc2e', '#28c840'].map(c => (
                    <span key={c} style={{ width: 10, height: 10, borderRadius: 999, background: c, opacity: 0.5 }} />
                  ))}
                </div>
                <span style={{ marginLeft: 8 }}>~/kostops</span>
              </div>
              <div style={{ padding: 20, fontFamily: a.font.mono, fontSize: 13, lineHeight: 1.7, color: '#cbd2dd' }}>
                <div><span style={{ color: '#7d8595' }}># Run KostOps locally</span></div>
                <div><span style={{ color: a.c.brandSoft }}>$</span> docker run -d \</div>
                <div style={{ paddingLeft: 16 }}>-p <span style={{ color: a.c.orange }}>3000:3000</span> \</div>
                <div style={{ paddingLeft: 16 }}>-e AWS_PROFILE=<span style={{ color: a.c.orange }}>finops</span> \</div>
                <div style={{ paddingLeft: 16 }}>kostops/kostops:<span style={{ color: a.c.orange }}>latest</span></div>
                <div style={{ marginTop: 10 }}><span style={{ color: '#7d8595' }}># Open the dashboard</span></div>
                <div><span style={{ color: a.c.brandSoft }}>$</span> open http://localhost:<span style={{ color: a.c.orange }}>3000</span></div>
                <div style={{ marginTop: 14, color: a.c.ok }}>✓ Connected to 4 accounts. Indexing 30d of CUR…</div>
              </div>
            </div>

            {/* Contributors avatars */}
            <div style={{ marginTop: 24 }}>
              <div style={{ fontFamily: a.font.mono, fontSize: 11, color: a.c.inkDim, letterSpacing: '0.06em', marginBottom: 10 }}>RECENT CONTRIBUTORS</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Array.from({ length: 18 }).map((_, i) => {
                  const colors = [a.c.brand, a.c.violet, a.c.teal, a.c.orange, a.c.ok, a.c.cyan];
                  const initials = ['JK', 'MR', 'AT', 'LP', 'NS', 'DB', 'CY', 'EH', 'IM', 'OZ', 'PK', 'QV', 'RW', 'SG', 'TF', 'UJ', 'VL', 'WX'];
                  return (
                    <div key={i} style={{
                      width: 32, height: 32, borderRadius: 999,
                      background: colors[i % colors.length],
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontFamily: a.font.mono, fontSize: 10, fontWeight: 700,
                    }}>{initials[i]}</div>
                  );
                })}
                <div style={{
                  width: 32, height: 32, borderRadius: 999,
                  background: a.c.bgSunken, color: a.c.inkSoft,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: a.font.mono, fontSize: 10, fontWeight: 700,
                  border: `1px solid ${a.c.rule}`,
                }}>+166</div>
              </div>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

const StatCard = ({ value, label, icon }) => (
  <div style={{
    border: `1px solid ${a.c.rule}`, borderRadius: a.r.md, padding: 16,
    background: a.c.bg,
  }}>
    <div style={{ fontFamily: a.font.sans, fontSize: 24, fontWeight: 700, color: a.c.ink, fontFeatureSettings: '"tnum"', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: a.c.brand, fontSize: 18 }}>{icon}</span>{value}
    </div>
    <div style={{ fontFamily: a.font.mono, fontSize: 10, color: a.c.inkDim, letterSpacing: '0.08em', marginTop: 2 }}>{label}</div>
  </div>
);

// ---------- CTA + Footer ----------

function CTA() {
  return (
    <section style={{ padding: '120px 0', background: a.c.bg }}>
      <Container>
        <div style={{
          background: a.c.ink, borderRadius: a.r.xl + 4, padding: 64,
          textAlign: 'center', position: 'relative', overflow: 'hidden',
        }}>
          {/* Glow */}
          <div style={{
            position: 'absolute', top: -100, left: '50%', transform: 'translateX(-50%)',
            width: 600, height: 300, borderRadius: '50%',
            background: `radial-gradient(circle, ${a.c.brand}33 0%, transparent 70%)`,
            pointerEvents: 'none',
          }} />
          <div style={{ position: 'relative' }}>
            <h2 style={{
              fontFamily: a.font.sans, fontSize: 56, lineHeight: 1.05,
              letterSpacing: '-0.03em', fontWeight: 700, color: '#fff',
              margin: '0 0 18px', textWrap: 'balance',
            }}>
              Find waste. Fix it. Done.
            </h2>
            <p style={{ fontFamily: a.font.sans, fontSize: 18, color: '#cbd2dd', margin: '0 0 32px', maxWidth: 520, marginLeft: 'auto', marginRight: 'auto' }}>
              Free, open source, self-hosted. Up and running in five minutes.
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <Btn kind="brand" href="https://github.com/udaykirannag2/kostops" target="_blank" rel="noopener noreferrer">Star on GitHub</Btn>
              <Btn kind="secondary" href="#" style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', borderColor: 'rgba(255,255,255,0.18)' }}>Book a demo</Btn>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{ padding: '64px 0 48px', background: a.c.bg, borderTop: `1px solid ${a.c.rule}` }}>
      <Container>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 48, marginBottom: 56 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <img src="logo-mark.svg" width={28} height={28} alt="" />
              <span style={{ fontFamily: a.font.sans, fontWeight: 700, fontSize: 17, color: a.c.ink }}>KostOps</span>
            </div>
            <p style={{ fontFamily: a.font.sans, fontSize: 14, lineHeight: 1.55, color: a.c.inkSoft, margin: 0, maxWidth: 280 }}>
              The open-source FinOps platform for AWS. Self-hosted, AI-native, MIT-licensed.
            </p>
          </div>
          <FooterCol title="PRODUCT" links={['Findings', 'Compute', 'Commitments', 'Kost Agent', 'Demo']} hrefs={['#', '#', '#', '#', 'https://www.youtube.com/watch?v=c45qbWEdTcs&feature=youtu.be']} />
          <FooterCol title="OPEN SOURCE" links={['GitHub', 'Contributors', 'Roadmap', 'Discussions', 'Issues']} hrefs={['https://github.com/udaykirannag2/kostops', '#', '#', '#', '#']} />
          <FooterCol title="RESOURCES" links={['Documentation', 'Self-host guide', 'API reference', 'Discord']} hrefs={['https://github.com/udaykirannag2/kostops/blob/main/README.md', '#', '#', '#']} />
          <FooterCol title="COMPANY" links={['About', 'Contact sales', 'Security', 'Status', 'Press kit']} />
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          paddingTop: 24, borderTop: `1px solid ${a.c.rule}`,
          fontFamily: a.font.mono, fontSize: 11, color: a.c.inkDim, letterSpacing: '0.04em',
        }}>
          <span>© 2025 KOSTOPS · MIT LICENSED</span>
          <span>v0.18.2 · ALL SYSTEMS NORMAL</span>
        </div>
      </Container>
    </footer>
  );
}

const FooterCol = ({ title, links, hrefs = [] }) => (
  <div>
    <div style={{ fontFamily: a.font.mono, fontSize: 10, color: a.c.inkDim, letterSpacing: '0.1em', marginBottom: 14 }}>{title}</div>
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {links.map((l, i) => {
        const href = hrefs[i] || '#';
        const external = href.startsWith('http');
        return (
          <li key={l}>
            <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}
               style={{ fontFamily: a.font.sans, fontSize: 13, color: a.c.inkSoft, textDecoration: 'none' }}>{l}</a>
          </li>
        );
      })}
    </ul>
  </div>
);

// ---------- Page ----------

function Page() {
  return (
    <div style={{ background: a.c.bg, minHeight: '100vh' }}>
      <Nav />
      <Hero />
      <AgentShowcase />
      <Features />
      <OpenSource />
      <CTA />
      <Footer />
    </div>
  );
}

Object.assign(window, { Page });
