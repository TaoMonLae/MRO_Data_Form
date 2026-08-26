import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, Archive, ArrowRight, BarChart3, Bell, BookOpen, BriefcaseBusiness,
  Building2, CalendarClock, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Database,
  Download, ExternalLink, FileCheck2, FileDown, FileText, Filter, Globe2, HandHeart,
  HeartHandshake, Home, KeyRound, LayoutDashboard, LockKeyhole, LogOut, Mail, MapPin,
  Menu, Moon, MoreHorizontal, Pencil, Plus, Printer, RefreshCw, Search, Settings, ShieldCheck,
  Sparkles, Sun, Trash2, Upload, UserCog, UserRound, Users, Workflow, X, CheckCircle2, AlertTriangle
} from 'lucide-react';
import { api } from './api';
import Threads from './components/reactbits/Threads';

const ROLE_LABELS = {
  admin: 'Admin',
  chair: 'Chair Person',
  secretary: 'Secretary',
  hr: 'HR',
  card_printing: 'Card Printing Staff',
  data_management: 'Data Management Staff',
  finance: 'Finance Officer'
};

const NAV_ITEMS = [
  { to: '/app', label: 'My workspace', icon: LayoutDashboard },
  { to: '/app/admin', label: 'Operations overview', icon: BarChart3, permission: 'users:manage' },
  { to: '/app/members', label: 'Member records', icon: Database, permission: 'members:view' },
  { to: '/app/carding', label: 'Daily carding', icon: FileCheck2, permission: 'carding:view' },
  { to: '/app/finance', label: 'Finance records', icon: BriefcaseBusiness, permission: 'finance:view' },
  { to: '/app/hr', label: 'HR & staff', icon: UserCog, permission: 'hr:view' },
  { to: '/app/attendance', label: 'Attendance', icon: CalendarClock },
  { to: '/app/users', label: 'Users & roles', icon: Users, permission: 'users:manage' },
  { to: '/app/audit', label: 'Activity log', icon: Activity, permission: 'audit:view' },
  { to: '/app/data-care', label: 'Data care', icon: ShieldCheck, permission: 'members:view' },
  { to: '/app/settings', label: 'Office settings', icon: Settings, permission: 'settings:manage' }
];

const PUBLIC_NAV = [
  { to: '/', label: 'Home' },
  { to: '/about', label: 'About MRO' },
  { to: '/faq', label: 'FAQ' }
];

const EMPTY_MEMBER = {
  reference: '', reference_number: '', fullname: '', gender: 'Male', dob: '', father_name: '', mother_name: '',
  arrival: '', email: '', phone: '', unhcr_status: 'No', unhcr_file_number: '',
  individual_number: '', country: 'Myanmar', ethnicity: 'Mon', religion: 'Buddhism',
  address_state: '', vulnerability: 'N/A', consent: 'yes'
};

const EMPTY_FINANCE = {
  payment_date: new Date().toISOString().slice(0, 10), concern_person: '', concern_number: '', service_type: '',
  amount: '', deduction: '', net_amount: '', payment_method: 'Not recorded', payment_status: 'Not recorded', notes: ''
};

const EMPTY_CARDING = {
  record_date: new Date().toISOString().slice(0, 10), category: 'service', service_type: 'MRO New', paid_cards: 0,
  unpaid_cards: 0, rate: 130, amount: 0, payment_method: 'Not recorded', notes: ''
};

const EMPLOYMENT_LABELS = {
  full_time: 'Full-time', part_time: 'Part-time', volunteer: 'Volunteer', contract: 'Contract'
};

const ThemeContext = createContext({ theme: 'light', setTheme: () => {} });

function ThemeToggle({ className = '' }) {
  const { theme, setTheme } = useContext(ThemeContext);
  const dark = theme === 'dark';
  return <button type="button" className={`theme-toggle ${className}`} onClick={() => setTheme(dark ? 'light' : 'dark')}
    aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`} title={`Switch to ${dark ? 'light' : 'dark'} mode`} aria-pressed={dark}>
    <span className="theme-toggle__track" aria-hidden="true"><Sun size={14} /><Moon size={14} /><i /></span>
    <span className="theme-toggle__label">{dark ? 'Dark' : 'Light'}</span>
  </button>;
}

function useApiResource(path) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setError('');
    try {
      const result = await api(path);
      if (requestId.current === id) setData(result);
    } catch (requestError) {
      if (requestId.current === id) setError(requestError.message);
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [path]);
  useEffect(() => { load(); return () => { requestId.current += 1; }; }, [load]);
  return { data, loading, error, reload: load };
}

function can(user, permission) {
  return !permission || user?.permissions?.includes(permission);
}

function formatDate(value) {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return value;
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR', maximumFractionDigits: 2 }).format(Number(value || 0));
}

function dateForInput(value) {
  if (!value) return '';
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

function captureClockLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser does not support location. Use a device with location services enabled.'));
    navigator.geolocation.getCurrentPosition(position => resolve({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      captured_at: new Date(position.timestamp || Date.now()).toISOString()
    }), error => {
      const messages = {
        1: 'Location access is blocked. Allow precise location for this site in your browser settings, then try again.',
        2: 'Your device could not determine its location. Turn on location services, move near a window, and try again.',
        3: 'Location checking took too long. Check your signal and try again.'
      };
      reject(new Error(messages[error.code] || 'The device could not verify your location. Try again.'));
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
  });
}

async function submitAttendanceClock(action, geofence) {
  if (geofence?.enabled && !geofence.configured) throw new Error('Office location lock needs administrator setup before attendance can be recorded.');
  const location = geofence?.enabled ? await captureClockLocation() : null;
  return api('/api/attendance/clock', { method: 'POST', body: JSON.stringify({ action, location }) });
}

async function verifyAttendanceLocation(geofence) {
  if (!geofence?.enabled) return { verified: true, distanceMeters: null };
  if (!geofence.configured) throw new Error('Office location lock needs administrator setup before attendance can be recorded.');
  const location = await captureClockLocation();
  return api('/api/attendance/location-check', { method: 'POST', body: JSON.stringify({ location }) });
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'MRO';
}

function StatusBadge({ children, tone = 'neutral' }) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

function Button({ children, variant = 'primary', icon: Icon, className = '', ...props }) {
  return <button className={`button button--${variant} ${className}`} {...props}>
    {Icon && <Icon size={16} strokeWidth={2} aria-hidden="true" />}{children}
  </button>;
}

function EmptyState({ icon: Icon = Archive, title, children }) {
  return <div className="empty-state"><Icon size={28} aria-hidden="true" /><h3>{title}</h3><p>{children}</p></div>;
}

function PageState({ loading = false, title, message, onRetry }) {
  if (loading) return <section className="page-state page-state--loading" aria-live="polite" aria-busy="true">
    <div className="state-skeleton"><span /><span /><span /></div><RefreshCw className="spin" size={18} /><div><h2>Loading {title.toLowerCase()}…</h2><p>Connecting to the MRO operations database.</p></div>
  </section>;
  return <section className="page-state page-state--error" role="alert"><AlertTriangle size={24} />
    <div><p className="kicker">Unable to load</p><h2>{title}</h2><p>{message || 'The request could not be completed.'}</p></div>
    {onRetry && <Button variant="secondary" icon={RefreshCw} onClick={onRetry}>Try again</Button>}
  </section>;
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  const Icon = toast.type === 'error' ? AlertTriangle : CheckCircle2;
  return <div className={`toast toast--${toast.type || 'success'}`} role="status">
    <Icon size={18} /><span>{toast.message}</span><button onClick={onClose} aria-label="Dismiss"><X size={16} /></button>
  </div>;
}

function BrandLockup({ inverse = false }) {
  return <NavLink to="/" className={`public-brand ${inverse ? 'public-brand--inverse' : ''}`} aria-label="Mon Refugee Organization home">
    <img src="/assets/mro-logo.png" alt="" width="58" height="48" />
    <span><strong>Mon Refugee Organization</strong><small>Malaysia · Member operations</small></span>
  </NavLink>;
}

function PublicHeader({ session }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return <header className="public-header">
    <BrandLockup />
    <button className="public-menu" onClick={() => setOpen(value => !value)} aria-label="Toggle website navigation" aria-expanded={open}><Menu /></button>
    <nav className={open ? 'public-nav public-nav--open' : 'public-nav'} aria-label="Public navigation">
      {PUBLIC_NAV.map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'}>{item.label}</NavLink>)}
      <ThemeToggle className="theme-toggle--public" />
      <NavLink className="public-nav__portal" to={session ? '/app' : '/login'}>{session ? 'Open workspace' : 'Staff sign in'} <ArrowRight size={15} /></NavLink>
    </nav>
  </header>;
}

function PublicFooter() {
  return <footer className="public-footer">
    <div className="public-footer__lead"><BrandLockup inverse /><p>Careful records. Accountable access. Dignified member service.</p></div>
    <div><strong>Organization</strong><NavLink to="/about">About MRO</NavLink><NavLink to="/faq">Frequently asked questions</NavLink></div>
    <div><strong>Staff</strong><NavLink to="/login">Staff portal</NavLink><span>Asia/Kuala_Lumpur</span></div>
    <div className="public-footer__note">
      <p>MRO operates in Malaysia. This registry is an MRO internal system and is not an official UNHCR database.</p>
      <p>Developed by <a href="https://github.com/TaoMonLae" target="_blank" rel="noreferrer" aria-label="Tao Mon Lae on GitHub (opens in a new tab)">Tao Mon Lae <ExternalLink size={12} aria-hidden="true" /></a></p>
    </div>
  </footer>;
}

function PublicFrame({ session, children }) {
  return <div className="public-site"><PublicHeader session={session} />{children}<PublicFooter /></div>;
}

function LogoMotion() {
  return <div className="logo-motion" aria-hidden="true">
    <div className="logo-motion__threads"><Threads color={[1, 0.76, 0.05]} amplitude={0.34} distance={0.16} enableMouseInteraction={false} /></div>
    <div className="logo-motion__orbit logo-motion__orbit--one" />
    <div className="logo-motion__orbit logo-motion__orbit--two" />
    <img className="logo-motion__image" src="/assets/mro-logo.png" alt="" width="920" height="750" />
    <div className="logo-motion__sweep" />
  </div>;
}

const FAQ_ITEMS = [
  ['Who can view or edit member records?', 'Access follows staff roles. Admin, Chair Person, Card Printing Staff and Data Management Staff receive only the record permissions required for their duties.'],
  ['Does this replace UNHCR systems?', 'No. This is an internal MRO registry for data keeping and preparation of the expected registration request form. It is not an official UNHCR database.'],
  ['Can existing Excel data be imported?', 'Yes. Authorized staff can import Excel or CSV files using MRO Status number, name, gender, date of birth, parents’ names, arrival date, email and phone fields.'],
  ['How are member photos handled?', 'A JPG or PNG can be uploaded to a member record. The server saves it using the MRO Status number so printing staff can reliably match the image and record.'],
  ['What happens when a form is printed?', 'The system generates an A4 PDF from the stored member data and records the action in the audit log. Staff should still review the preview before giving it to a member.'],
  ['How should sensitive data be protected?', 'Use individual staff accounts, strong passwords, encrypted backups, private PostgreSQL access and a documented retention process. Never share exports through personal messaging accounts.']
];

function LandingPage({ session }) {
  return <PublicFrame session={session}>
    <main>
      <section className="public-hero">
        <LogoMotion />
        <div className="public-hero__content">
          <p className="public-eyebrow"><span /> MRO Malaysia · Internal operations</p>
          <h1>Member records that stay ready for the moment they are needed.</h1>
          <p className="public-hero__lead">One accountable workspace for refugee data keeping, staff attendance and consistent A4 registration-request printing.</p>
          <div className="public-hero__actions"><NavLink className="public-button public-button--light" to={session ? '/app' : '/login'}>{session ? 'Open workspace' : 'Staff sign in'} <ArrowRight size={17} /></NavLink><NavLink className="public-button public-button--ghost" to="/about">How MRO works</NavLink></div>
        </div>
        <div className="public-metric-strip" aria-label="System scope">
          <div><strong>7</strong><span>Defined staff roles</span></div>
          <div><strong>A4</strong><span>Print-ready member form</span></div>
          <div><strong>MYT</strong><span>Malaysia attendance time</span></div>
          <div><strong>1</strong><span>Auditable source of truth</span></div>
        </div>
      </section>

      <section className="public-intro" id="operations">
        <p className="public-section-index">01 · The operating model</p>
        <div><h2>From scattered spreadsheets to a controlled member workflow.</h2><p>MRO’s registry keeps the familiar MRO Status number at the centre, then connects the member’s identity, family details, contact information, photo and print history around it.</p></div>
      </section>

      <section className="workflow-ledger" aria-label="Registry workflow">
        {[
          ['01', 'Keep', 'Import existing Excel data or add a member with structured fields and a matching photo.'],
          ['02', 'Review', 'Search by MRO number, name, email or phone; identify missing photos and incomplete core details.'],
          ['03', 'Print', 'Preview a consistent A4 registration request and record the print action for accountability.']
        ].map(([number, title, text], index) => <article key={title} className={index === 1 ? 'workflow-ledger__row workflow-ledger__row--focus' : 'workflow-ledger__row'}><span>{number}</span><h3>{title}</h3><p>{text}</p><ArrowRight aria-hidden="true" /></article>)}
      </section>

      <section className="public-proof">
        <div className="public-proof__statement"><p className="public-section-index">02 · Built around real MRO work</p><h2>Operational proof, not decorative promises.</h2></div>
        <div className="proof-list">
          <div><FileCheck2 /><span><strong>Exact-field continuity</strong>Preserves the identifiers and personal fields already used in MRO spreadsheets.</span></div>
          <div><ShieldCheck /><span><strong>Role boundaries</strong>Editing, printing, importing, exporting and user access are separate permissions.</span></div>
          <div><Activity /><span><strong>Accountable actions</strong>Changes, imports, exports, sign-ins and prints are recorded with staff context.</span></div>
          <div><Printer /><span><strong>Print preparation</strong>Photos and missing details are surfaced before a member form is generated.</span></div>
        </div>
      </section>

      <section className="public-about-band">
        <div><p className="public-section-index">03 · About MRO</p><h2>A community organization working with care, continuity and dignity.</h2></div>
        <div><p>The registry is designed for staff serving Mon refugees in Malaysia. It supports the organization’s administrative work while keeping clear boundaries around sensitive data and UNHCR-related forms.</p><NavLink className="public-text-link" to="/about">Read about the organization <ArrowRight size={16} /></NavLink></div>
      </section>

      <section className="public-faq-preview">
        <div><p className="public-section-index">04 · Common questions</p><h2>Clear answers before staff enter sensitive information.</h2></div>
        <div className="faq-list">{FAQ_ITEMS.slice(0, 4).map(([question, answer]) => <details key={question}><summary>{question}<Plus size={18} /></summary><p>{answer}</p></details>)}</div>
        <NavLink className="public-text-link" to="/faq">View all questions <ArrowRight size={16} /></NavLink>
      </section>
    </main>
  </PublicFrame>;
}

function AboutPage({ session }) {
  return <PublicFrame session={session}><main className="public-inner-page">
    <section className="public-page-heading"><p className="public-eyebrow"><span /> About the organization</p><h1>Structured support for Mon refugees in Malaysia.</h1><p>MRO’s internal registry gives staff a careful way to maintain member information, prepare forms and make operational responsibility visible.</p></section>
    <section className="about-manifesto"><p className="public-section-index">Our working principles</p><div><h2>Serve the person, protect the record.</h2><p>Sensitive information should move only where it has a defined purpose. MRO’s workflow combines practical access for authorized staff with search, review, printing and audit controls.</p></div></section>
    <section className="principle-grid">
      <article><HandHeart /><h3>Dignity</h3><p>Member details and photos are shown only where they support a real staff task.</p></article>
      <article><Database /><h3>Continuity</h3><p>Existing spreadsheet fields remain familiar while PostgreSQL becomes the durable source of truth.</p></article>
      <article><UserCog /><h3>Responsibility</h3><p>Roles define who may edit, print, export or administer accounts.</p></article>
      <article><Globe2 /><h3>Local context</h3><p>Attendance and operational timestamps follow Asia/Kuala_Lumpur.</p></article>
    </section>
    <section className="unhcr-context"><div><p className="public-section-index">UNHCR context</p><h2>Clear about what this system is—and what it is not.</h2></div><p>MRO operates under the wider refugee-support context of UNHCR Malaysia and prepares the expected form for members. The application does not claim to be operated, approved or hosted by UNHCR.</p></section>
  </main></PublicFrame>;
}

function FaqPage({ session }) {
  return <PublicFrame session={session}><main className="public-inner-page public-faq-page">
    <section className="public-page-heading"><p className="public-eyebrow"><span /> Frequently asked questions</p><h1>Using the MRO registry responsibly.</h1><p>Practical guidance for staff accounts, imports, member photos, form printing and data protection.</p></section>
    <section className="faq-list faq-list--large">{FAQ_ITEMS.map(([question, answer], index) => <details key={question}><summary><span>{String(index + 1).padStart(2, '0')}</span>{question}<Plus size={20} /></summary><p>{answer}</p></details>)}</section>
    <section className="faq-contact"><Mail /><div><h2>Need an account or policy answer?</h2><p>Contact the MRO administrator or Chair Person through the organization’s approved staff channel.</p></div></section>
  </main></PublicFrame>;
}

function NotFoundPage({ session, app = false }) {
  const destination = app && session ? '/app' : '/';
  return <main className={app ? 'not-found not-found--app' : 'not-found'}>
    <div className="not-found__mark"><img src="/assets/mro-logo.png" alt="" /><span>404</span></div>
    <p className="public-section-index">Route not found</p><h1>This page is outside the registry.</h1><p>The link may be old or your role may use a different workspace route.</p>
    <NavLink className="public-button public-button--dark" to={destination}><Home size={17} /> {app ? 'Return to workspace' : 'Return home'}</NavLink>
  </main>;
}

function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try { onLogin(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }

  return <main className="login-page">
    <section className="login-story" aria-label="About the MRO registry">
      <div className="login-threads"><Threads color={[1, 0.76, 0.05]} amplitude={0.48} distance={0.18} /></div>
      <div className="login-story__content">
        <div className="brand-lockup brand-lockup--inverse">
          <img src="/assets/mro-logo.png" alt="Mon Refugee Organization" />
          <span><strong>MRO Registry</strong><small>Member data & form operations</small></span>
        </div>
        <div className="login-copy">
          <p className="kicker">Mon Refugee Organization</p>
          <h1>Keep every member record ready when it matters.</h1>
          <p>A secure working space for careful data keeping, UNHCR form printing and accountable staff operations.</p>
          <div className="trust-line"><ShieldCheck size={18} /> Role-based access · Audit-ready · Malaysia time</div>
        </div>
        <p className="login-note">Operate with dignity. Collect only what is needed.</p>
      </div>
    </section>
    <section className="login-panel">
      <ThemeToggle className="theme-toggle--login" />
      <form className="login-form" onSubmit={submit}>
        <div className="login-mark"><img src="/assets/mro-logo.png" alt="" /></div>
        <p className="kicker">Staff portal</p>
        <h2>Welcome back</h2>
        <p className="muted">Sign in with your MRO staff account.</p>
        {error && <div className="form-alert" role="alert"><AlertTriangle size={17} />{error}</div>}
        <label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</Button>
        <p className="login-help"><CircleHelp size={15} /> Need access? Contact the MRO administrator.</p>
        <NavLink className="login-home-link" to="/"><ArrowRight size={15} /> Return to the MRO website</NavLink>
      </form>
    </section>
  </main>;
}

function FirstLoginPasswordPage({ user, onChanged, onLogout }) {
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const longEnough = form.new_password.length >= 12;
  const changed = Boolean(form.new_password) && form.new_password !== form.current_password;
  const matches = Boolean(form.confirm_password) && form.new_password === form.confirm_password;

  async function submit(event) {
    event.preventDefault();
    setError(''); setBusy(true);
    try {
      const updated = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify(form) });
      onChanged(updated);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }

  return <main className="login-page password-change-page">
    <section className="login-story" aria-label="Account security">
      <div className="login-threads"><Threads color={[1, 0.76, 0.05]} amplitude={0.42} distance={0.2} /></div>
      <div className="login-story__content">
        <div className="brand-lockup brand-lockup--inverse"><img src="/assets/mro-logo.png" alt="Mon Refugee Organization" /><span><strong>MRO Registry</strong><small>Protected staff access</small></span></div>
        <div className="login-copy"><p className="kicker">First sign-in</p><h1>Make this account yours.</h1><p>Your temporary password has opened the door once. Replace it now before entering the registry.</p><div className="trust-line"><LockKeyhole size={18} /> One required security step · No registry access until complete</div></div>
        <p className="login-note">Your administrator cannot see the password you choose.</p>
      </div>
    </section>
    <section className="login-panel">
      <ThemeToggle className="theme-toggle--login" />
      <form className="login-form password-change-form" onSubmit={submit}>
        <div className="password-change-form__identity"><span className="avatar">{initials(user.name)}</span><span><strong>{user.name}</strong><small>{user.email}</small></span></div>
        <p className="kicker">Account security</p><h2>Choose a new password</h2><p className="muted">This replaces the temporary password issued by your administrator.</p>
        {error && <div className="form-alert" role="alert"><AlertTriangle size={17} />{error}</div>}
        <label>Temporary password<input type="password" value={form.current_password} onChange={e => setForm({ ...form, current_password: e.target.value })} autoComplete="current-password" required autoFocus /></label>
        <label>New password<input type="password" minLength="12" maxLength="200" value={form.new_password} onChange={e => setForm({ ...form, new_password: e.target.value })} autoComplete="new-password" required /></label>
        <label>Confirm new password<input type="password" minLength="12" maxLength="200" value={form.confirm_password} onChange={e => setForm({ ...form, confirm_password: e.target.value })} autoComplete="new-password" required /></label>
        <div className="password-rules" aria-live="polite">
          <span className={longEnough ? 'is-valid' : ''}><CheckCircle2 /> At least 12 characters</span>
          <span className={changed ? 'is-valid' : ''}><CheckCircle2 /> Different from the temporary password</span>
          <span className={matches ? 'is-valid' : ''}><CheckCircle2 /> Both new-password fields match</span>
        </div>
        <Button type="submit" disabled={busy || !longEnough || !changed || !matches}>{busy ? 'Saving password…' : 'Save password and continue'}</Button>
        <button className="password-signout" type="button" onClick={onLogout}><LogOut size={15} /> Sign out instead</button>
      </form>
    </section>
  </main>;
}

function AppShell({ user, onLogout, children }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  const active = location.pathname === '/app/profile' ? 'Profile & access' : NAV_ITEMS.find(item => item.to === location.pathname)?.label || 'MRO Registry';

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand"><img src="/assets/mro-logo.png" alt="MRO" /><span><strong>MRO Registry</strong><small>Operations workspace</small></span></div>
      <nav aria-label="Main navigation">
        <p className="nav-label">Workspace</p>
        {NAV_ITEMS.filter(item => can(user, item.permission)).map(({ to, label, icon: Icon }) =>
          <NavLink key={to} to={to} end={to === '/app'} className={({ isActive }) => isActive ? 'nav-item nav-item--active' : 'nav-item'}>
            <Icon size={18} strokeWidth={1.9} /><span>{label}</span>
          </NavLink>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-safety"><LockKeyhole size={16} /><span><strong>Confidential records</strong><small>Never share your sign-in.</small></span></div>
        <div className="profile-chip">
          <NavLink to="/app/profile" title="Open profile"><span className="avatar">{initials(user.name)}</span><span><strong>{user.name}</strong><small>{ROLE_LABELS[user.role]}</small></span></NavLink>
          <button onClick={onLogout} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
        </div>
      </div>
    </aside>
    {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    <div className="app-main">
      <header className="topbar">
        <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></button>
        <div><p className="topbar-context">MRO Operations</p><h1>{active}</h1></div>
        <div className="topbar-actions"><ThemeToggle /><span className="confidential-pill"><ShieldCheck size={14} /> Confidential</span><button aria-label="Notifications"><Bell size={19} /></button><NavLink to="/app/profile" className="avatar avatar--small" aria-label="Open profile">{initials(user.name)}</NavLink></div>
      </header>
      <div className="page-content">{children}</div>
    </div>
  </div>;
}

function DashboardPage({ user, showToast }) {
  const { data, loading, error, reload: load } = useApiResource('/api/dashboard');
  const [busy, setBusy] = useState(false);
  const [locationProof, setLocationProof] = useState(null);

  async function verifyLocation() {
    setBusy(true);
    try { const proof = await verifyAttendanceLocation(data?.geofence); setLocationProof(proof); showToast(`Office location verified${proof.distanceMeters == null ? '' : ` · ${proof.distanceMeters} m away`}.`); }
    catch (error) { setLocationProof(null); showToast(error.message, 'error'); }
    finally { setBusy(false); }
  }

  async function clock(action) {
    setBusy(true);
    try { const result = await submitAttendanceClock(action, data?.geofence); showToast(result.message); setLocationProof(null); load(); }
    catch (error) { showToast(error.message, 'error'); }
    finally { setBusy(false); }
  }

  if (loading && !data) return <PageState loading title="Workspace" />;
  if (error && !data) return <PageState title="Workspace unavailable" message={error} onRetry={load} />;
  const stats = data?.stats || {};
  const personal = data?.overview?.personal || {};
  const finance = data?.overview?.finance;
  const workforce = data?.overview?.workforce;
  const roleFocus = can(user, 'finance:view')
    ? { label: 'Collected this month', value: formatMoney(finance?.collected), detail: `${finance?.transactions ?? 0} payment records`, icon: BriefcaseBusiness, tone: 'green' }
    : can(user, 'hr:view')
      ? { label: 'Active staff', value: workforce?.activeStaff ?? 0, detail: `${workforce?.partTimeStaff ?? 0} part-time staff`, icon: UserCog, tone: 'blue' }
      : can(user, 'members:view')
        ? { label: 'Member records', value: stats.members ?? 0, detail: `${stats.needsReview ?? 0} need follow-up`, icon: Users, tone: 'blue' }
        : { label: 'Attendance status', value: data?.attendance?.status === 'clocked_in' ? 'In' : 'Out', detail: 'Malaysia office time', icon: Clock3, tone: 'green' };
  return <>
    <section className="page-hero page-hero--compact">
      <div><p className="kicker">Wednesday · Kuala Lumpur</p><h2>Good day, {user.name.split(' ')[0]}.</h2><p>Here is what needs attention across member records and print operations.</p></div>
      <ClockCard attendance={data?.attendance} geofence={data?.geofence} locationProof={locationProof} busy={busy} onVerify={verifyLocation} onClock={clock} />
    </section>
    <section className="stat-grid" aria-label="Personal KPI overview">
      <Stat label="Days recorded" value={personal.daysRecorded ?? 0} detail="Attendance entries this month" icon={CalendarClock} />
      <Stat label="Completed shifts" value={personal.completedShifts ?? 0} detail="Clock-in and clock-out complete" icon={CheckCircle2} tone="green" />
      <Stat label="Hours this month" value={personal.hoursThisMonth ?? 0} detail="Completed attendance hours" icon={Clock3} tone="amber" />
      <Stat {...roleFocus} />
    </section>
    <div className="content-grid content-grid--dashboard">
      {can(user, 'members:view') && <section className="panel">
        <div className="panel-heading"><div><p className="kicker">Work queue</p><h3>Records needing attention</h3></div><NavLink to="/app/members" className="text-link">View all <ChevronRight size={15} /></NavLink></div>
        <div className="attention-list">
          {(data?.attention || []).map(item => <NavLink to={`/app/members?open=${item.id}`} className="attention-item" key={item.id}>
            <span className="member-avatar">{item.photo_url ? <img src={item.photo_url} alt="" /> : initials(item.fullname)}</span>
            <span><strong>{item.fullname}</strong><small>{item.reference} · {item.reason}</small></span><StatusBadge tone={item.tone}>{item.label}</StatusBadge><ChevronRight size={16} />
          </NavLink>)}
          {data && !data.attention?.length && <EmptyState title="Queue is clear">No member records need immediate attention.</EmptyState>}
        </div>
      </section>}
      {!can(user, 'members:view') && can(user, 'finance:view') && <section className="panel role-overview-panel"><div className="panel-heading"><div><p className="kicker">Finance overview</p><h3>Payment control</h3></div><NavLink to="/app/finance" className="text-link">Open finance <ChevronRight size={15} /></NavLink></div><div className="overview-ledger"><div><span>Net collected</span><strong>{formatMoney(finance?.collected)}</strong></div><div><span>Deductions</span><strong>{formatMoney(finance?.deductions)}</strong></div><div><span>Pending / partial</span><strong>{finance?.pending ?? 0}</strong></div></div></section>}
      {!can(user, 'members:view') && !can(user, 'finance:view') && can(user, 'hr:view') && <section className="panel role-overview-panel"><div className="panel-heading"><div><p className="kicker">People overview</p><h3>Workforce this month</h3></div><NavLink to="/app/hr" className="text-link">Open HR <ChevronRight size={15} /></NavLink></div><div className="overview-ledger"><div><span>Active staff</span><strong>{workforce?.activeStaff ?? 0}</strong></div><div><span>Part-time staff</span><strong>{workforce?.partTimeStaff ?? 0}</strong></div><div><span>Hours recorded</span><strong>{workforce?.hoursThisMonth ?? 0}</strong></div></div></section>}
      <section className="panel">
        <div className="panel-heading"><div><p className="kicker">Recent</p><h3>Registry activity</h3></div>{can(user, 'audit:view') && <NavLink to="/app/audit" className="text-link">Audit log <ChevronRight size={15} /></NavLink>}</div>
        <div className="timeline">
          {(data?.activity || []).map(item => <div className="timeline-item" key={item.id}><span className="timeline-dot" /><div><strong>{item.action}</strong><p>{item.detail}</p><small>{item.actor_name} · {item.created_at}</small></div></div>)}
          {data && !data.activity?.length && <EmptyState icon={Activity} title="No activity yet">Actions taken in the registry will appear here.</EmptyState>}
        </div>
      </section>
    </div>
  </>;
}

function LocationLockStatus({ geofence, attendance, locationProof, inverse = false }) {
  const configured = geofence?.configured;
  const enabled = geofence?.enabled;
  const lastDistance = attendance?.clock_out_location_verified
    ? attendance.clock_out_distance_meters
    : attendance?.clock_in_location_verified ? attendance.clock_in_distance_meters : null;
  const tone = enabled && configured ? 'active' : enabled ? 'warning' : 'off';
  return <div className={`location-lock location-lock--${tone} ${inverse ? 'location-lock--inverse' : ''}`}>
    <span className="location-lock__icon"><MapPin size={15} /></span>
    <span><strong>{enabled && configured ? 'Office location required' : enabled ? 'Location lock needs setup' : 'Location lock is off'}</strong>
      <small>{locationProof?.verified ? `Ready to clock · ${locationProof.distanceMeters ?? 0} m from office` : lastDistance != null ? `Last clock verified ${lastDistance} m from office` : enabled && configured ? `${geofence.radiusMeters} m office zone · precise location only` : enabled ? 'Attendance is paused until coordinates are added' : 'Enable the office geofence in server settings'}</small>
    </span>
    {enabled && configured && <ShieldCheck size={15} className="location-lock__check" />}
  </div>;
}

function ClockCard({ attendance, geofence, locationProof, busy, onVerify, onClock }) {
  const clockedIn = attendance?.status === 'clocked_in';
  const blocked = geofence?.enabled && !geofence?.configured;
  const needsCheck = geofence?.enabled && !locationProof?.verified;
  return <div className="clock-card"><div className="clock-card__body"><div><span className={`live-dot ${clockedIn ? 'live-dot--on' : ''}`} /> <strong>{clockedIn ? 'Currently clocked in' : 'Not clocked in'}</strong><p>{clockedIn ? `Started at ${attendance.clock_in}` : 'Record your attendance for today.'}</p></div><LocationLockStatus geofence={geofence} attendance={attendance} locationProof={locationProof} /></div>
    <Button variant={needsCheck ? 'secondary' : clockedIn ? 'danger' : 'primary'} icon={busy ? RefreshCw : needsCheck ? MapPin : Clock3} className={busy ? 'is-loading' : ''} disabled={busy || blocked} onClick={() => needsCheck ? onVerify() : onClock(clockedIn ? 'out' : 'in')}>{busy ? 'Checking location…' : needsCheck ? 'Verify office location' : clockedIn ? 'Clock out' : 'Clock in'}</Button>
  </div>;
}

function Stat({ label, value, detail, icon: Icon, tone = 'navy' }) {
  return <article className="stat-card"><span className={`stat-icon stat-icon--${tone}`}><Icon size={19} /></span><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function AreaTrendChart({ data = [], label = 'Trend during the last six months' }) {
  const width = 680; const height = 238; const inset = 22;
  const max = Math.max(1, ...data.map(item => Number(item.value || 0)));
  const points = data.map((item, index) => ({
    ...item,
    x: data.length <= 1 ? width / 2 : inset + index * ((width - inset * 2) / (data.length - 1)),
    y: height - 42 - (Number(item.value || 0) / max) * (height - 78)
  }));
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const area = points.length ? `${line} L ${points.at(-1).x} ${height - 42} L ${points[0].x} ${height - 42} Z` : '';
  return <div className="trend-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <defs><linearGradient id="registryArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d9231e" stopOpacity=".24" /><stop offset="1" stopColor="#d9231e" stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3].map(index => <line key={index} className="chart-grid-line" x1={inset} x2={width - inset} y1={36 + index * 48} y2={36 + index * 48} />)}
      {area && <path d={area} fill="url(#registryArea)" />}
      {line && <path className="chart-line" d={line} />}
      {points.map(point => <g key={point.label}><circle className="chart-dot" cx={point.x} cy={point.y} r="4" /><text className="chart-value" x={point.x} y={point.y - 13}>{point.value}</text><text className="chart-label" x={point.x} y={height - 15}>{point.label}</text></g>)}
    </svg>
  </div>;
}

function GenderBreakdown({ data = [] }) {
  const total = data.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const colors = ['#d9231e', '#d4ad19', '#193448', '#6e7f8a', '#a5b0b7'];
  let offset = 0;
  return <div className="breakdown-chart"><svg viewBox="0 0 160 160" role="img" aria-label="Member gender breakdown">
    <circle className="donut-track" cx="80" cy="80" r="54" />
    {data.map((item, index) => { const amount = total ? Number(item.value) / total * 339.292 : 0; const element = <circle key={item.label} className="donut-segment" cx="80" cy="80" r="54" stroke={colors[index % colors.length]} strokeDasharray={`${amount} ${339.292 - amount}`} strokeDashoffset={-offset} />; offset += amount; return element; })}
    <text x="80" y="77" textAnchor="middle" className="donut-total">{total}</text><text x="80" y="96" textAnchor="middle" className="donut-caption">members</text>
  </svg><div className="breakdown-legend">{data.map((item, index) => <div key={item.label}><span style={{ background: colors[index % colors.length] }} /><strong>{item.label}</strong><small>{item.value}</small></div>)}</div></div>;
}

function BreakdownLedger({ groups = [] }) {
  return <div className="breakdown-ledger">{groups.map(group => {
    const total = group.items.reduce((sum, item) => sum + Number(item.value || 0), 0);
    return <section key={group.title}><header><strong>{group.title}</strong><span>{total} people</span></header><div className="breakdown-bars">{group.items.map(item => {
      const percent = total ? Math.round(Number(item.value || 0) / total * 100) : 0;
      return <div key={item.label}><div><span>{item.label}</span><strong>{item.value} <small>{percent}%</small></strong></div><i><b style={{ width: `${percent}%` }} /></i></div>;
    })}</div></section>;
  })}</div>;
}

function KpiLedger({ stats, overview }) {
  const members = Number(stats.members || 0);
  const workforce = overview?.workforce || {};
  const items = [
    { label: 'Data completeness', value: members ? Math.round((members - Number(stats.needsReview || 0)) / members * 100) : 0, suffix: '%', detail: `${stats.needsReview ?? 0} records need review` },
    { label: 'Print readiness', value: members ? Math.round(Number(stats.readyToPrint || 0) / members * 100) : 0, suffix: '%', detail: `${stats.readyToPrint ?? 0} records ready` },
    { label: 'Workforce participation', value: Number(workforce.activeStaff) ? Math.round(Number(workforce.activeThisMonth || 0) / Number(workforce.activeStaff) * 100) : 0, suffix: '%', detail: `${workforce.activeThisMonth ?? 0}/${workforce.activeStaff ?? 0} staff recorded time` },
    { label: 'Finance collected', value: formatMoney(overview?.finance?.collected), detail: `${overview?.finance?.transactions ?? 0} payments this month`, money: true }
  ];
  return <section className="kpi-ledger" aria-label="Administrative key performance indicators"><header><div><p className="kicker">Administrative KPI</p><h3>Operating health</h3></div><span>Current month</span></header><div>{items.map(item => <article key={item.label}><span>{item.label}</span><strong>{item.value}{item.suffix}</strong><small>{item.detail}</small>{!item.money && <i><b style={{ width: `${item.value}%` }} /></i>}</article>)}</div></section>;
}

function CoverageChart({ data = [] }) {
  return <div className="coverage-chart">{data.map(item => { const value = Number(item.value || 0); const total = Number(item.total || 0); const percent = total ? Math.round(value / total * 100) : 0; return <div key={item.label}><span>{item.label}</span><div><i style={{ width: `${percent}%` }} /></div><strong>{value}/{total}</strong></div>; })}</div>;
}

function AdminDashboardPage({ user, showToast }) {
  const { data, loading, error, reload } = useApiResource('/api/dashboard');
  if (loading && !data) return <PageState loading title="Operations overview" />;
  if (error && !data) return <PageState title="Operations overview unavailable" message={error} onRetry={reload} />;
  const stats = data?.stats || {};
  return <>
    <section className="page-title-row admin-title"><div><p className="kicker">Organization control room</p><h2>Operations overview</h2><p>Registry readiness, attendance coverage and recent work across MRO.</p></div><div className="admin-title__meta"><span className="live-dot live-dot--on" /> Live PostgreSQL data</div></section>
    <section className="admin-stat-strip" aria-label="Organization metrics">
      <div><span>Registry</span><strong>{stats.members ?? '—'}</strong><small>{stats.addedThisMonth ?? 0} added this month</small></div>
      <div><span>Print ready</span><strong>{stats.readyToPrint ?? '—'}</strong><small>{stats.missingPhotos ?? 0} photos · {stats.missingReferenceNumbers ?? 0} references missing</small></div>
      <div><span>Staff access</span><strong>{stats.activeUsers ?? '—'}</strong><small>{stats.presentNow ?? 0} currently clocked in</small></div>
      <div><span>Forms issued</span><strong>{stats.printedThisMonth ?? '—'}</strong><small>Recorded this month</small></div>
    </section>
    <KpiLedger stats={stats} overview={data?.overview} />
    <section className="analytics-layout">
      <article className="analytics-panel analytics-panel--trend"><header><div><p className="kicker">Registry movement</p><h3>New member records</h3></div><span>Last 6 months</span></header><AreaTrendChart data={data?.charts?.registryTrend} /></article>
      <article className="analytics-panel"><header><div><p className="kicker">Identity data</p><h3>Gender breakdown</h3></div></header><GenderBreakdown data={data?.charts?.genderBreakdown} /></article>
      <article className="analytics-panel analytics-panel--demographics"><header><div><p className="kicker">Age & safeguarding</p><h3>Adult and underage breakdown</h3></div><span>Age calculated from date of birth</span></header><BreakdownLedger groups={[{ title: 'Age group', items: data?.charts?.ageBreakdown || [] }, { title: 'Underage gender', items: data?.charts?.underageGender || [] }]} /></article>
      <article className="analytics-panel analytics-panel--coverage"><header><div><p className="kicker">Workforce coverage</p><h3>Staff attendance</h3></div><span>Last 7 days</span></header><CoverageChart data={data?.charts?.attendanceCoverage} /></article>
      <article className="analytics-panel analytics-panel--queue"><header><div><p className="kicker">Clearable queue</p><h3>Records needing action</h3></div><NavLink className="text-link" to="/app/members">Open records <ArrowRight size={15} /></NavLink></header><div className="attention-list">{(data?.attention || []).map(item => <NavLink to={`/app/members?open=${item.id}`} className="attention-item" key={item.id}><span className="member-avatar">{item.photo_url ? <img src={item.photo_url} alt="" /> : initials(item.fullname)}</span><span><strong>{item.fullname}</strong><small>{item.reference} · {item.reason}</small></span><StatusBadge tone={item.tone}>{item.label}</StatusBadge><ChevronRight size={16} /></NavLink>)}{data && !data.attention?.length && <EmptyState title="Queue is clear">No member records need immediate attention.</EmptyState>}</div></article>
    </section>
  </>;
}

function ProfilePage({ user, showToast }) {
  const emptyPasswordForm = { current_password: '', new_password: '', confirm_password: '' };
  const [passwordForm, setPasswordForm] = useState(emptyPasswordForm);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const longEnough = passwordForm.new_password.length >= 12;
  const changed = Boolean(passwordForm.new_password) && passwordForm.new_password !== passwordForm.current_password;
  const matches = Boolean(passwordForm.confirm_password) && passwordForm.new_password === passwordForm.confirm_password;
  const permissionLabels = {
    'members:view': 'View member records', 'members:edit': 'Edit member records', 'members:import': 'Import spreadsheets',
    'members:export': 'Export spreadsheets', 'print:forms': 'Generate member forms', 'finance:view': 'View finance records',
    'finance:edit': 'Manage payments', 'hr:view': 'View workforce records', 'hr:edit': 'Manage staff profiles',
    'carding:view': 'View daily carding ledger', 'carding:edit': 'Manage carding and expenses',
    'settings:manage': 'Manage office location lock', 'users:manage': 'Manage users & roles', 'audit:view': 'Review audit activity'
  };

  async function changePassword(event) {
    event.preventDefault();
    setPasswordError(''); setPasswordSuccess(''); setPasswordBusy(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify(passwordForm) });
      setPasswordForm(emptyPasswordForm);
      setPasswordSuccess('Password updated. Other signed-in sessions were ended to protect this account.');
      showToast?.('Password updated securely.');
    } catch (requestError) { setPasswordError(requestError.message); }
    finally { setPasswordBusy(false); }
  }

  return <><section className="profile-hero"><div className="profile-identity"><span className="profile-avatar">{initials(user.name)}</span><div><p className="kicker">Staff profile</p><h2>{user.name}</h2><p>{user.email}</p></div></div><StatusBadge tone="success">Active account</StatusBadge></section>
    <div className="profile-layout"><section className="panel profile-panel"><div className="panel-heading"><div><p className="kicker">Role assignment</p><h3>{ROLE_LABELS[user.role]}</h3></div><ShieldCheck /></div><div className="profile-role-copy"><p>{roleSummary(user.role)}</p><dl><div><dt>Workspace</dt><dd>MRO Registry</dd></div><div><dt>Time zone</dt><dd>Asia/Kuala_Lumpur</dd></div><div><dt>Account ID</dt><dd className="mono">{user.id}</dd></div></dl></div></section>
      <section className="panel profile-panel"><div className="panel-heading"><div><p className="kicker">Access scope</p><h3>What this account can do</h3></div><KeyRound /></div><div className="permission-list">{Object.entries(permissionLabels).map(([permission, label]) => <div key={permission} className={user.permissions.includes(permission) ? 'permission permission--granted' : 'permission'}>{user.permissions.includes(permission) ? <Check /> : <X />}<span>{label}</span><small>{user.permissions.includes(permission) ? 'Granted' : 'Not granted'}</small></div>)}</div></section>
    </div>
    <section className="panel profile-password-panel">
      <div className="panel-heading"><div><p className="kicker">Account security</p><h3>Password &amp; sessions</h3></div><LockKeyhole /></div>
      <div className="profile-password-layout">
        <div className="profile-password-copy"><span className="profile-password-icon"><ShieldCheck /></span><h4>Keep this account personal</h4><p>Verify your current password, then choose a replacement that you do not use elsewhere.</p><small>After the change, this device stays signed in and other signed-in sessions are ended.</small></div>
        <form className="profile-password-form" onSubmit={changePassword}>
          {passwordError && <div className="form-alert" role="alert"><AlertTriangle size={17} />{passwordError}</div>}
          {passwordSuccess && <div className="form-success" role="status"><CheckCircle2 size={17} />{passwordSuccess}</div>}
          <div className="profile-password-fields">
            <Field label="Current password" required><input type="password" value={passwordForm.current_password} onChange={event => setPasswordForm({ ...passwordForm, current_password: event.target.value })} autoComplete="current-password" required /></Field>
            <Field label="New password" required><input type="password" minLength="12" maxLength="200" value={passwordForm.new_password} onChange={event => setPasswordForm({ ...passwordForm, new_password: event.target.value })} autoComplete="new-password" required /></Field>
            <Field label="Confirm new password" required><input type="password" minLength="12" maxLength="200" value={passwordForm.confirm_password} onChange={event => setPasswordForm({ ...passwordForm, confirm_password: event.target.value })} autoComplete="new-password" required /></Field>
          </div>
          <div className="password-rules" aria-live="polite">
            <span className={longEnough ? 'is-valid' : ''}><CheckCircle2 /> At least 12 characters</span>
            <span className={changed ? 'is-valid' : ''}><CheckCircle2 /> Different from the current password</span>
            <span className={matches ? 'is-valid' : ''}><CheckCircle2 /> Both new-password fields match</span>
          </div>
          <div className="profile-password-actions"><Button type="submit" icon={KeyRound} disabled={passwordBusy || !passwordForm.current_password || !longEnough || !changed || !matches}>{passwordBusy ? 'Updating password…' : 'Update password'}</Button></div>
        </form>
      </div>
    </section>
  </>;
}

function ImportReviewModal({ preview, type = 'members', committing, onClose, onCommit }) {
  const validIds = useMemo(() => preview.rows.filter(row => row.valid).map(row => row.id), [preview]);
  const [selected, setSelected] = useState(() => new Set(validIds));
  const [page, setPage] = useState(0);
  const pageSize = 200;
  const pageCount = Math.max(1, Math.ceil(preview.rows.length / pageSize));
  const visibleRows = preview.rows.slice(page * pageSize, (page + 1) * pageSize);
  const allSelected = validIds.length > 0 && validIds.every(id => selected.has(id));
  function toggle(id) { setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function toggleAll() { setSelected(allSelected ? new Set() : new Set(validIds)); }
  return <div className="modal-layer"><button className="drawer-scrim" onClick={onClose} aria-label="Close import review" /><section className="modal-card import-review" role="dialog" aria-modal="true" aria-labelledby="import-review-title">
    <header><div><p className="kicker">Migration review</p><h2 id="import-review-title">Choose rows to import</h2><p>{preview.sourceName}</p></div><button type="button" onClick={onClose} aria-label="Close"><X /></button></header>
    <div className="import-review__summary"><span><strong>{preview.rows.length}</strong> found</span><span className="is-ready"><strong>{preview.valid}</strong> ready</span><span className="is-attention"><strong>{preview.attention}</strong> need attention</span><span><strong>{page + 1}/{pageCount}</strong> pages</span><Button variant="secondary" onClick={toggleAll}>{allSelected ? 'Clear selection' : 'Select all ready'}</Button></div>
    <div className="import-review__table table-scroll"><table className="data-table"><thead><tr><th><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all valid rows" /></th><th>Source</th>{type === 'members' ? <><th>MRO status</th><th>Member</th><th>Gender</th></> : <><th>Date</th><th>Service / expense</th><th>Cards</th></>}<th>Status</th></tr></thead><tbody>{visibleRows.map(row => <tr key={row.id} className={row.valid ? '' : 'import-row--invalid'}><td><input type="checkbox" checked={selected.has(row.id)} disabled={!row.valid} onChange={() => toggle(row.id)} aria-label={`Select source row ${row.sourceRow}`} /></td><td><strong>{row.sheet}</strong><small className="table-subline">Row {row.sourceRow}</small></td>{type === 'members' ? <><td className="mono">{row.reference || '—'}</td><td><strong>{row.fullname || '—'}</strong><small className="table-subline">{row.reference_number || 'No reference number'}</small></td><td>{row.gender || '—'}</td></> : <><td>{formatDate(row.record_date)}</td><td><strong>{row.service_type}</strong><small className="table-subline">{row.category} · {formatMoney(row.net_amount)}</small></td><td>{row.paid_cards} paid · {row.unpaid_cards} unpaid</td></>}<td><StatusBadge tone={row.valid ? 'success' : 'warning'}>{row.valid ? 'Ready' : row.issue}</StatusBadge></td></tr>)}</tbody></table></div>
    <footer><p>{selected.size} rows selected. Existing or invalid records remain unchecked.</p><div className="import-review__pages"><Button variant="secondary" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="secondary" disabled={page >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Next</Button></div><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Upload} disabled={!selected.size || committing} onClick={() => onCommit([...selected])}>{committing ? 'Importing…' : `Import ${selected.size} rows`}</Button></footer>
  </section></div>;
}

function MembersPage({ user, showToast }) {
  const location = useLocation();
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [photoFilter, setPhotoFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [photoImporting, setPhotoImporting] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const mayEdit = can(user, 'members:edit');
  const mayPrint = can(user, 'print:forms');

  async function load() {
    setLoading(true); setLoadError('');
    try {
      const params = new URLSearchParams({ q: query, photo: photoFilter });
      const data = await api(`/api/members?${params}`); setRows(data.records);
      const openId = new URLSearchParams(location.search).get('open');
      if (openId && !editing) setEditing(data.records.find(row => String(row.id) === openId) || null);
    } catch (error) { setLoadError(error.message); showToast(error.message, 'error'); }
    finally { setLoading(false); }
  }
  useEffect(() => { const timer = setTimeout(load, 180); return () => clearTimeout(timer); }, [query, photoFilter, location.search]);

  async function save(formData, id) {
    try {
      await api(id ? `/api/members/${id}` : '/api/members', { method: id ? 'PUT' : 'POST', body: formData });
      setEditing(null); showToast(id ? 'Member record updated.' : 'Member record added.'); load();
    } catch (error) { showToast(error.message, 'error'); throw error; }
  }

  async function importFile(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setImporting(true);
    const data = new FormData(); data.append('file', file);
    try { const result = await api('/api/members/import/preview', { method: 'POST', body: data }); setImportPreview(result); }
    catch (error) { showToast(error.message, 'error'); }
    finally { setImporting(false); event.target.value = ''; }
  }

  async function commitImport(selectedIds) {
    setImporting(true);
    try { const result = await api('/api/members/import/commit', { method: 'POST', body: JSON.stringify({ batchId: importPreview.batchId, selectedIds }) }); showToast(`${result.imported} selected records imported; ${result.skipped} skipped.`); setImportPreview(null); load(); }
    catch (error) { showToast(error.message, 'error'); }
    finally { setImporting(false); }
  }

  async function importPhotos(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setPhotoImporting(true); const data = new FormData(); data.append('file', file);
    try { const result = await api('/api/members/photos/bulk', { method: 'POST', body: data }); showToast(`${result.matched} photos matched to member records${result.unmatched.length ? `; ${result.unmatched.length} unmatched` : ''}.`); load(); }
    catch (error) { showToast(error.message, 'error'); }
    finally { setPhotoImporting(false); event.target.value = ''; }
  }

  return <>
    <section className="page-title-row">
      <div><p className="kicker">Data keeping & printing</p><h2>Member records</h2><p>Search, migrate photos and print forms from one accountable member record.</p></div>
      <div className="title-actions">
        {can(user, 'members:import') && <label className="button button--secondary file-button"><Upload size={16} />{importing ? 'Preparing…' : 'Review Excel import'}<input type="file" accept=".xlsx,.xls,.csv" onChange={importFile} disabled={importing} /></label>}
        {mayEdit && <label className="button button--secondary file-button"><Archive size={16} />{photoImporting ? 'Matching photos…' : 'Import photo ZIP'}<input type="file" accept=".zip,application/zip" onChange={importPhotos} disabled={photoImporting} /></label>}
        {can(user, 'members:export') && <a className="button button--secondary" href="/api/members/export"><Download size={16} />Export Excel</a>}
        {mayEdit && <Button icon={Plus} onClick={() => setEditing({ ...EMPTY_MEMBER })}>Add member</Button>}
      </div>
    </section>
    <section className="panel records-panel">
      <div className="records-toolbar">
        <label className="search-control"><Search size={18} /><span className="sr-only">Search members</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search MRO, Reference Number, name, email or phone…" /></label>
        <label className="filter-control"><Filter size={16} /><span>Photo</span><select value={photoFilter} onChange={event => setPhotoFilter(event.target.value)}><option value="all">All records</option><option value="ready">Ready</option><option value="missing">Missing</option></select><ChevronDown size={15} /></label>
        <span className="record-count">{rows.length} records</span>
      </div>
      <div className="table-scroll">
        <table className="data-table"><thead><tr><th>Member</th><th>MRO status no.</th><th>Reference no.</th><th>Gender</th><th>Date of birth</th><th>Phone</th><th>Photo</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <td><button className="member-cell" onClick={() => setEditing(row)}><span className="member-avatar">{row.photo_url ? <img src={row.photo_url} alt="" /> : initials(row.fullname)}</span><span><strong>{row.fullname}</strong><small>{row.email || 'No email'}</small></span></button></td>
            <td><span className="mono">{row.reference}</span></td><td><span className="mono">{row.reference_number || '—'}</span></td><td>{row.gender || '—'}</td><td>{formatDate(row.dob)}</td><td>{row.phone || '—'}</td>
            <td>{row.photo_url ? <StatusBadge tone="success">Ready</StatusBadge> : <StatusBadge tone="warning">Missing</StatusBadge>}</td>
            <td><div className="row-actions">{mayPrint && <button disabled={!row.reference_number} title={row.reference_number ? 'Preview form' : 'Add a Reference Number before printing'} onClick={() => window.open(`/api/members/${row.id}/print`, '_blank')} aria-label={`Print form for ${row.fullname}`}><Printer size={17} /></button>}{mayEdit && <button onClick={() => setEditing(row)} aria-label={`Edit ${row.fullname}`}><Pencil size={17} /></button>}</div></td>
          </tr>)}</tbody></table>
        {!loading && loadError && <PageState title="Member records unavailable" message={loadError} onRetry={load} />}
        {!loading && !loadError && !rows.length && <EmptyState icon={Search} title="No matching records">Try a different search or photo filter.</EmptyState>}
        {loading && <div className="loading-row"><RefreshCw className="spin" size={18} />Loading records…</div>}
      </div>
    </section>
    {editing && <MemberDrawer member={editing} canEdit={mayEdit} canPrint={mayPrint} onClose={() => setEditing(null)} onSave={save} />}
    {importPreview && <ImportReviewModal preview={importPreview} committing={importing} onClose={() => setImportPreview(null)} onCommit={commitImport} />}
  </>;
}

function MemberDrawer({ member, canEdit, canPrint, onClose, onSave }) {
  const [form, setForm] = useState({ ...EMPTY_MEMBER, ...member, dob: dateForInput(member.dob), arrival: dateForInput(member.arrival) });
  const [photo, setPhoto] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (name, value) => setForm(current => ({ ...current, [name]: value }));

  async function submit(event) {
    event.preventDefault(); if (!canEdit) return;
    const data = new FormData(); Object.entries(form).forEach(([key, value]) => value != null && data.append(key, value)); if (photo) data.append('photo', photo);
    setSaving(true); try { await onSave(data, member.id); } finally { setSaving(false); }
  }

  return <div className="drawer-layer" role="dialog" aria-modal="true" aria-labelledby="member-drawer-title">
    <button className="drawer-scrim" onClick={onClose} aria-label="Close member record" />
    <aside className="drawer"><header className="drawer-header"><div><p className="kicker">{member.id ? 'Member record' : 'New record'}</p><h2 id="member-drawer-title">{member.fullname || 'Add member'}</h2>{member.reference && <span className="mono">MRO {member.reference}{member.reference_number ? ` · Ref ${member.reference_number}` : ''}</span>}</div><button onClick={onClose} aria-label="Close"><X /></button></header>
      <form className="drawer-form" onSubmit={submit}>
        <section className="photo-editor"><span className="photo-preview">{member.photo_url ? <img src={member.photo_url} alt={`Current photo for ${member.fullname}`} /> : <UserRound size={42} />}</span><div><strong>Member photo</strong><p>JPG or PNG, up to 4 MB. Saved as the MRO status number.</p>{canEdit && <label className="text-link file-button"><Upload size={15} />Choose photo<input type="file" accept="image/jpeg,image/png" onChange={e => setPhoto(e.target.files?.[0] || null)} /></label>}{photo && <small>{photo.name}</small>}</div></section>
        <FormSection title="Core identity"><div className="form-grid">
          <Field label="MRO status number" required><input value={form.reference} onChange={e => set('reference', e.target.value)} required disabled={!canEdit} /></Field>
          <Field label="Reference Number"><input value={form.reference_number || ''} onChange={e => set('reference_number', e.target.value)} disabled={!canEdit} placeholder="Reference shown on printed form…" /></Field>
          <Field label="Full name" required><input value={form.fullname} onChange={e => set('fullname', e.target.value)} required disabled={!canEdit} /></Field>
          <Field label="Gender"><select value={form.gender} onChange={e => set('gender', e.target.value)} disabled={!canEdit}><option>Male</option><option>Female</option><option>Other</option></select></Field>
          <Field label="Date of birth"><input type="date" value={form.dob} onChange={e => set('dob', e.target.value)} disabled={!canEdit} /></Field>
          <Field label="Father's name"><input value={form.father_name || ''} onChange={e => set('father_name', e.target.value)} disabled={!canEdit} /></Field>
          <Field label="Mother's name"><input value={form.mother_name || ''} onChange={e => set('mother_name', e.target.value)} disabled={!canEdit} /></Field>
          <Field label="Date of arrival in Malaysia"><input type="date" value={form.arrival} onChange={e => set('arrival', e.target.value)} disabled={!canEdit} /></Field>
        </div></FormSection>
        <FormSection title="Contact"><div className="form-grid"><Field label="Email"><input type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} disabled={!canEdit} /></Field><Field label="Phone number"><input value={form.phone || ''} onChange={e => set('phone', e.target.value)} disabled={!canEdit} /></Field></div></FormSection>
        <FormSection title="UNHCR & registration"><div className="form-grid">
          <Field label="Registered with UNHCR?"><select value={form.unhcr_status || 'No'} onChange={e => set('unhcr_status', e.target.value)} disabled={!canEdit}><option>No</option><option>Yes</option></select></Field>
          <Field label="UNHCR file number"><input value={form.unhcr_file_number || ''} onChange={e => set('unhcr_file_number', e.target.value)} disabled={!canEdit || form.unhcr_status !== 'Yes'} /></Field>
          <Field label="Individual number"><input value={form.individual_number || ''} onChange={e => set('individual_number', e.target.value)} disabled={!canEdit || form.unhcr_status !== 'Yes'} /></Field>
          <Field label="Country of origin"><input value={form.country || ''} onChange={e => set('country', e.target.value)} disabled={!canEdit} /></Field>
          <Field label="Ethnicity"><input value={form.ethnicity || ''} onChange={e => set('ethnicity', e.target.value)} disabled={!canEdit} /></Field>
          <Field label="Religion"><input value={form.religion || ''} onChange={e => set('religion', e.target.value)} disabled={!canEdit} /></Field>
        </div></FormSection>
        <footer className="drawer-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>{canPrint && member.id && <Button type="button" variant="secondary" icon={Printer} disabled={!member.reference_number} title={member.reference_number ? 'Preview form' : 'Save a Reference Number before printing'} onClick={() => window.open(`/api/members/${member.id}/print`, '_blank')}>Preview form</Button>}{canEdit && <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save record'}</Button>}</footer>
      </form>
    </aside>
  </div>;
}

function FormSection({ title, children }) { return <section className="form-section"><h3>{title}</h3>{children}</section>; }
function Field({ label, required, hint, children }) { return <label className="field"><span>{label}{required && <em>*</em>}</span>{hint && <small>{hint}</small>}{children}</label>; }

function AttendancePage({ showToast }) {
  const { data, loading, error, reload: load } = useApiResource('/api/attendance');
  const [busy, setBusy] = useState(false);
  const [locationProof, setLocationProof] = useState(null);
  async function verifyLocation() {
    setBusy(true);
    try { const proof = await verifyAttendanceLocation(data?.geofence); setLocationProof(proof); showToast(`Office location verified${proof.distanceMeters == null ? '' : ` · ${proof.distanceMeters} m away`}.`); }
    catch (error) { setLocationProof(null); showToast(error.message, 'error'); }
    finally { setBusy(false); }
  }
  async function clock(action) {
    setBusy(true);
    try { const result = await submitAttendanceClock(action, data?.geofence); showToast(result.message); setLocationProof(null); load(); }
    catch (error) { showToast(error.message, 'error'); }
    finally { setBusy(false); }
  }
  if (loading && !data) return <PageState loading title="Attendance" />;
  if (error && !data) return <PageState title="Attendance unavailable" message={error} onRetry={load} />;
  const needsLocationCheck = data.geofence?.enabled && !locationProof?.verified;
  return <><section className="page-title-row"><div><p className="kicker">Staff operations</p><h2>Clock in & attendance</h2><p>Times are recorded in Asia/Kuala_Lumpur.</p></div></section>
    <section className="attendance-hero"><div><p className="kicker">Today</p><h3>{new Intl.DateTimeFormat('en-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</h3><p>{data.current?.status === 'clocked_in' ? `Clocked in at ${data.current.clock_in}` : data.current?.clock_out ? `Completed · ${data.current.clock_in}–${data.current.clock_out}` : 'You have not clocked in today.'}</p></div><div className="attendance-hero__actions"><LocationLockStatus geofence={data.geofence} attendance={data.current} locationProof={locationProof} inverse /><Button variant={needsLocationCheck ? 'secondary' : data.current?.status === 'clocked_in' ? 'danger' : 'primary'} icon={busy ? RefreshCw : needsLocationCheck ? MapPin : Clock3} className={busy ? 'is-loading' : ''} disabled={busy || (data.geofence?.enabled && !data.geofence?.configured)} onClick={() => needsLocationCheck ? verifyLocation() : clock(data.current?.status === 'clocked_in' ? 'out' : 'in')}>{busy ? 'Checking location…' : needsLocationCheck ? 'Verify office location' : data.current?.status === 'clocked_in' ? 'Clock out' : 'Clock in'}</Button></div></section>
    <div className="content-grid"><section className="panel"><div className="panel-heading"><div><p className="kicker">Personal</p><h3>Your recent attendance</h3></div></div><AttendanceTable rows={data.history} /></section><section className="panel"><div className="panel-heading"><div><p className="kicker">Today</p><h3>Team presence</h3></div></div><div className="presence-list">{data.team.map(row => <div key={row.user_id}><span className="avatar avatar--small">{initials(row.name)}</span><span><strong>{row.name}</strong><small>{ROLE_LABELS[row.role]}</small></span><StatusBadge tone={row.clock_in && !row.clock_out ? 'success' : row.clock_out ? 'neutral' : 'warning'}>{row.clock_in && !row.clock_out ? 'In office' : row.clock_out ? 'Clocked out' : 'Not in'}</StatusBadge></div>)}</div></section></div>
  </>;
}

function AttendanceTable({ rows }) { return rows?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Date</th><th>Clock in</th><th>Clock out</th><th>Duration</th><th>Location proof</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{row.work_date}</td><td>{row.clock_in || '—'}</td><td>{row.clock_out || '—'}</td><td>{row.duration || '—'}</td><td><div className="attendance-proof"><span className={row.clock_in_location_verified ? 'is-verified' : ''}><MapPin size={13} /> In {row.clock_in_location_verified ? `${row.clock_in_distance_meters} m` : '—'}</span><span className={row.clock_out_location_verified ? 'is-verified' : ''}><MapPin size={13} /> Out {row.clock_out_location_verified ? `${row.clock_out_distance_meters} m` : '—'}</span></div></td></tr>)}</tbody></table></div> : <EmptyState icon={CalendarClock} title="No attendance yet">Your clock activity will appear here.</EmptyState>; }

function CardingPage({ showToast }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data, loading, error, reload } = useApiResource(`/api/carding?month=${month}`);
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const summary = data?.summary || {};
  async function save(event) {
    event.preventDefault();
    try { const id = editing.id; await api(id ? `/api/carding/${id}` : '/api/carding', { method: id ? 'PUT' : 'POST', body: JSON.stringify(editing) }); showToast(id ? 'Carding entry updated.' : 'Daily carding entry added.'); setEditing(null); reload(); }
    catch (requestError) { showToast(requestError.message, 'error'); }
  }
  async function previewWorkbook(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setImporting(true); const body = new FormData(); body.append('file', file);
    try { setImportPreview(await api('/api/carding/import/preview', { method: 'POST', body })); }
    catch (requestError) { showToast(requestError.message, 'error'); }
    finally { setImporting(false); event.target.value = ''; }
  }
  async function commitImport(selectedIds) {
    setImporting(true);
    try { const result = await api('/api/carding/import/commit', { method: 'POST', body: JSON.stringify({ batchId: importPreview.batchId, selectedIds }) }); showToast(`${result.imported} selected daily rows imported; ${result.skipped} skipped.`); setImportPreview(null); reload(); }
    catch (requestError) { showToast(requestError.message, 'error'); }
    finally { setImporting(false); }
  }
  if (loading && !data) return <PageState loading title="Daily carding" />;
  if (error && !data) return <PageState title="Daily carding unavailable" message={error} onRetry={reload} />;
  return <><section className="page-title-row"><div><p className="kicker">Card printing operations</p><h2>Daily carding & expenses</h2><p>Record paid and unpaid cards, service rates, other income and operating expenses.</p></div><div className="title-actions"><input className="month-control" type="month" value={month} onChange={event => setMonth(event.target.value)} /><label className="button button--secondary file-button"><Upload size={16} />{importing ? 'Preparing…' : 'Review carding workbook'}<input type="file" accept=".xlsx" onChange={previewWorkbook} disabled={importing} /></label><Button icon={Plus} onClick={() => setEditing({ ...EMPTY_CARDING })}>Add daily entry</Button></div></section>
    <section className="admin-stat-strip carding-stat-strip" aria-label="Daily carding summary"><div><span>Paid cards</span><strong>{summary.paidCards ?? 0}</strong><small>Issued and paid</small></div><div><span>Unpaid cards</span><strong>{summary.unpaidCards ?? 0}</strong><small>Follow-up required</small></div><div><span>Expenses</span><strong>{formatMoney(summary.expenses)}</strong><small>Recorded operating costs</small></div><div><span>Net position</span><strong>{formatMoney(summary.net)}</strong><small>{summary.entries ?? 0} ledger entries</small></div></section>
    <section className="panel records-panel"><div className="panel-heading"><div><p className="kicker">Daily ledger</p><h3>Card printing activity</h3></div><span className="record-count">{data?.records?.length || 0} entries</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Date</th><th>Type</th><th>Service / expense</th><th>Paid</th><th>Unpaid</th><th>Rate / amount</th><th>Net</th><th>Notes</th><th><span className="sr-only">Edit</span></th></tr></thead><tbody>{(data?.records || []).map(row => <tr key={row.id}><td>{formatDate(row.record_date)}</td><td><StatusBadge tone={row.category === 'expense' ? 'warning' : row.category === 'income' ? 'success' : 'blue'}>{row.category}</StatusBadge></td><td><strong>{row.service_type}</strong><small className="table-subline">{row.payment_method}</small></td><td>{row.paid_cards}</td><td>{row.unpaid_cards}</td><td>{row.category === 'service' ? formatMoney(row.rate) : formatMoney(row.amount)}</td><td><strong>{formatMoney(row.net_amount)}</strong></td><td className="notes-cell">{row.notes || row.source_name || '—'}</td><td><div className="row-actions"><button onClick={() => setEditing({ ...row, record_date: dateForInput(row.record_date) })} aria-label={`Edit ${row.service_type}`}><Pencil size={17} /></button></div></td></tr>)}</tbody></table>{!data?.records?.length && <EmptyState icon={FileCheck2} title="No carding entries">Add today’s card printing activity or review-import the office workbook.</EmptyState>}</div></section>
    {editing && <div className="modal-layer"><button className="drawer-scrim" onClick={() => setEditing(null)} aria-label="Close daily entry" /><form className="modal-card modal-card--wide" onSubmit={save}><header><div><p className="kicker">Daily ledger entry</p><h2>{editing.id ? 'Edit carding entry' : 'Add carding entry'}</h2></div><button type="button" onClick={() => setEditing(null)} aria-label="Close"><X /></button></header><div className="form-grid"><Field label="Date" required><input type="date" value={editing.record_date || ''} onChange={e => setEditing({ ...editing, record_date: e.target.value })} required /></Field><Field label="Entry type"><select value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })}><option value="service">Carding service</option><option value="income">Other income</option><option value="expense">Expense</option></select></Field><Field label="Service or expense type" required><input value={editing.service_type || ''} onChange={e => setEditing({ ...editing, service_type: e.target.value })} list="carding-services" required /><datalist id="carding-services"><option>MRO New</option><option>MRO Renew</option><option>MRO Late Fine</option><option>MRO Care</option><option>Marriage Cert</option><option>Donation</option><option>Received (prev month)</option><option>Card Delivery</option><option>Other Expense</option></datalist></Field><Field label="Payment method"><select value={editing.payment_method || 'Not recorded'} onChange={e => setEditing({ ...editing, payment_method: e.target.value })}><option>Not recorded</option><option>Cash</option><option>Bank transfer</option><option>E-wallet</option><option>Other</option></select></Field>{editing.category === 'service' ? <><Field label="Paid cards"><input type="number" min="0" value={editing.paid_cards ?? 0} onChange={e => setEditing({ ...editing, paid_cards: e.target.value })} /></Field><Field label="Unpaid cards"><input type="number" min="0" value={editing.unpaid_cards ?? 0} onChange={e => setEditing({ ...editing, unpaid_cards: e.target.value })} /></Field><Field label="Rate per card (RM)"><input type="number" min="0" step="0.01" value={editing.rate ?? 0} onChange={e => setEditing({ ...editing, rate: e.target.value })} /></Field></> : <Field label={`${editing.category === 'expense' ? 'Expense' : 'Income'} amount (RM)`}><input type="number" min="0" step="0.01" value={editing.amount ?? 0} onChange={e => setEditing({ ...editing, amount: e.target.value })} /></Field>}</div><Field label="Notes"><textarea rows="3" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} /></Field><footer><Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit">Save entry</Button></footer></form></div>}
    {importPreview && <ImportReviewModal preview={importPreview} type="carding" committing={importing} onClose={() => setImportPreview(null)} onCommit={commitImport} />}
  </>;
}

function OfficeSettingsPage({ showToast }) {
  const { data, loading, error, reload } = useApiResource('/api/settings/geofence');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setForm(current => current || { ...data }); }, [data]);
  async function useCurrentLocation() {
    setBusy(true);
    try { const location = await captureClockLocation(); setForm(current => ({ ...current, latitude: Number(location.latitude.toFixed(7)), longitude: Number(location.longitude.toFixed(7)) })); showToast('Current device coordinates added. Review the pin before saving.'); }
    catch (requestError) { showToast(requestError.message, 'error'); }
    finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault(); setBusy(true);
    try { const result = await api('/api/settings/geofence', { method: 'PUT', body: JSON.stringify(form) }); showToast(result.message); reload(); }
    catch (requestError) { showToast(requestError.message, 'error'); }
    finally { setBusy(false); }
  }
  if (loading && !form) return <PageState loading title="Office settings" />;
  if (error && !form) return <PageState title="Office settings unavailable" message={error} onRetry={reload} />;
  return <><section className="page-title-row"><div><p className="kicker">Administrative control</p><h2>Office location lock</h2><p>Define the only location where staff can enable Clock in and Clock out.</p></div><StatusBadge tone={form?.enabled && form?.configured ? 'success' : 'warning'}>{form?.enabled ? 'Enforced' : 'Disabled'}</StatusBadge></section>
    <form className="settings-ledger" onSubmit={save}><section><header><span className="settings-ledger__number">01</span><div><h3>Attendance location</h3><p>The saved pin is verified on the server for every clock action.</p></div></header><Field label="Office address" required><textarea rows="3" value={form?.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} required /></Field><div className="form-grid"><Field label="Latitude" required><input type="number" step="0.0000001" value={form?.latitude ?? ''} onChange={e => setForm({ ...form, latitude: e.target.value })} required /></Field><Field label="Longitude" required><input type="number" step="0.0000001" value={form?.longitude ?? ''} onChange={e => setForm({ ...form, longitude: e.target.value })} required /></Field></div><div className="settings-map-actions"><Button type="button" variant="secondary" icon={MapPin} disabled={busy} onClick={useCurrentLocation}>Use this device’s location</Button>{form?.latitude && form?.longitude && <a className="text-link" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${form.latitude}&mlon=${form.longitude}#map=19/${form.latitude}/${form.longitude}`}>Review pin on map <ExternalLink size={14} /></a>}</div></section><section><header><span className="settings-ledger__number">02</span><div><h3>Enforcement rules</h3><p>Keep the radius tight enough for the office while allowing normal phone accuracy.</p></div></header><label className="settings-switch"><input type="checkbox" checked={Boolean(form?.enabled)} onChange={e => setForm({ ...form, enabled: e.target.checked })} /><span><strong>Require office location</strong><small>Staff must verify inside the zone before clock buttons become available.</small></span></label><div className="form-grid"><Field label="Office radius (metres)"><input type="number" min="10" max="5000" value={form?.radiusMeters ?? 150} onChange={e => setForm({ ...form, radiusMeters: e.target.value })} /></Field><Field label="Maximum GPS uncertainty (metres)"><input type="number" min="10" max="1000" value={form?.maxAccuracyMeters ?? 100} onChange={e => setForm({ ...form, maxAccuracyMeters: e.target.value })} /></Field><Field label="Location reading expires after (seconds)"><input type="number" min="10" max="900" value={form?.maxAgeSeconds ?? 120} onChange={e => setForm({ ...form, maxAgeSeconds: e.target.value })} /></Field></div></section><footer><div><ShieldCheck size={18} /><span><strong>Privacy boundary</strong><small>Location is requested only for verification and clock actions, not continuous tracking.</small></span></div><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save location lock'}</Button></footer></form>
  </>;
}

function FinancePage({ showToast }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const { data, loading, error, reload } = useApiResource(`/api/finance?q=${encodeURIComponent(query)}`);
  const summary = data?.summary || {};

  async function save(event) {
    event.preventDefault();
    try {
      const id = editing.id;
      await api(id ? `/api/finance/${id}` : '/api/finance', { method: id ? 'PUT' : 'POST', body: JSON.stringify(editing) });
      showToast(id ? 'Finance record updated.' : 'Finance record added.'); setEditing(null); reload();
    } catch (requestError) { showToast(requestError.message, 'error'); }
  }

  async function importWorkbook(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setImporting(true); const body = new FormData(); body.append('file', file);
    try { const result = await api('/api/finance/import', { method: 'POST', body }); showToast(`${result.imported} payment rows imported; ${result.skipped} duplicates skipped.`); reload(); }
    catch (requestError) { showToast(requestError.message, 'error'); }
    finally { setImporting(false); event.target.value = ''; }
  }

  if (loading && !data) return <PageState loading title="Finance records" />;
  if (error && !data) return <PageState title="Finance records unavailable" message={error} onRetry={reload} />;
  return <><section className="page-title-row"><div><p className="kicker">Financial control</p><h2>Payments & banked-in records</h2><p>Track the Concern Person, their number, payment amount, deductions, method and status.</p></div><div className="title-actions"><label className="button button--secondary file-button"><Upload size={16} />{importing ? 'Importing…' : 'Import carding workbook'}<input type="file" accept=".xlsx" onChange={importWorkbook} disabled={importing} /></label><Button icon={Plus} onClick={() => setEditing({ ...EMPTY_FINANCE })}>Add payment</Button></div></section>
    <section className="admin-stat-strip finance-stat-strip" aria-label="Finance summary"><div><span>Payments</span><strong>{summary.transactions ?? 0}</strong><small>Recorded this month</small></div><div><span>Gross amount</span><strong>{formatMoney(summary.amount)}</strong><small>Before deductions</small></div><div><span>Deductions</span><strong>{formatMoney(summary.deductions)}</strong><small>Recorded this month</small></div><div><span>Net received</span><strong>{formatMoney(summary.net)}</strong><small>{summary.pending ?? 0} pending or partial</small></div></section>
    <section className="analytics-layout finance-analytics"><article className="analytics-panel"><header><div><p className="kicker">Cash movement</p><h3>Net received</h3></div><span>Last 6 months</span></header><AreaTrendChart data={data?.charts?.trend} label="Net payment amount during the last six months" /></article><article className="analytics-panel"><header><div><p className="kicker">Control gap</p><h3>Payment methods</h3></div></header><BreakdownLedger groups={[{ title: 'Method recorded', items: data?.charts?.methods || [] }]} /></article></section>
    <section className="panel records-panel finance-records"><div className="records-toolbar"><label className="search-control"><Search size={18} /><span className="sr-only">Search finance records</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Concern Person, number, service or notes…" /></label><span className="record-count">{data?.records?.length || 0} records</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Date</th><th>Concern Person</th><th>Concern Person’s number</th><th>Payment</th><th>Method</th><th>Status</th><th>Notes</th><th><span className="sr-only">Edit</span></th></tr></thead><tbody>{(data?.records || []).map(row => <tr key={row.id}><td>{formatDate(row.payment_date)}</td><td><strong>{row.concern_person || '—'}</strong><small className="table-subline">{row.service_type || 'No service type'}</small></td><td>{row.concern_number || '—'}</td><td><strong>{formatMoney(row.net_amount)}</strong><small className="table-subline">Gross {formatMoney(row.amount)}</small></td><td>{row.payment_method}</td><td><StatusBadge tone={row.payment_status === 'Paid' ? 'success' : row.payment_status === 'Pending' ? 'warning' : 'neutral'}>{row.payment_status}</StatusBadge></td><td className="notes-cell">{row.notes || '—'}</td><td><div className="row-actions"><button onClick={() => setEditing({ ...row, payment_date: dateForInput(row.payment_date) })} aria-label={`Edit payment for ${row.concern_person || row.concern_number}`}><Pencil size={17} /></button></div></td></tr>)}</tbody></table>{!data?.records?.length && <EmptyState icon={BriefcaseBusiness} title="No payment records">Add a payment or import the MRO carding workbook.</EmptyState>}</div></section>
    {editing && <div className="modal-layer"><button className="drawer-scrim" onClick={() => setEditing(null)} aria-label="Close finance form" /><form className="modal-card modal-card--wide" onSubmit={save}><header><div><p className="kicker">Finance record</p><h2>{editing.id ? 'Edit payment' : 'Add payment'}</h2></div><button type="button" onClick={() => setEditing(null)} aria-label="Close"><X /></button></header><div className="form-grid"><Field label="Payment date" required><input type="date" value={editing.payment_date || ''} onChange={e => setEditing({ ...editing, payment_date: e.target.value })} required /></Field><Field label="Service type"><input value={editing.service_type || ''} onChange={e => setEditing({ ...editing, service_type: e.target.value })} placeholder="MRO New, MRO Renew, Donation…" /></Field><Field label="Concern Person"><input value={editing.concern_person || ''} onChange={e => setEditing({ ...editing, concern_person: e.target.value })} /></Field><Field label="Concern Person’s number"><input value={editing.concern_number || ''} onChange={e => setEditing({ ...editing, concern_number: e.target.value })} /></Field><Field label="Payment amount (RM)" required><input type="number" min="0" step="0.01" value={editing.amount ?? ''} onChange={e => setEditing({ ...editing, amount: e.target.value, net_amount: '' })} required /></Field><Field label="Deduction (RM)"><input type="number" min="0" step="0.01" value={editing.deduction ?? ''} onChange={e => setEditing({ ...editing, deduction: e.target.value, net_amount: '' })} /></Field><Field label="Payment method"><select value={editing.payment_method || 'Not recorded'} onChange={e => setEditing({ ...editing, payment_method: e.target.value })}><option>Not recorded</option><option>Cash</option><option>Bank transfer</option><option>E-wallet</option><option>Cheque</option><option>Other</option></select></Field><Field label="Payment status"><select value={editing.payment_status || 'Not recorded'} onChange={e => setEditing({ ...editing, payment_status: e.target.value })}><option>Not recorded</option><option>Paid</option><option>Partial</option><option>Pending</option></select></Field></div><Field label="Notes"><textarea rows="3" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} /></Field><footer><Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit">Save payment</Button></footer></form></div>}
  </>;
}

function HrPage({ showToast }) {
  const { data, loading, error, reload } = useApiResource('/api/hr/staff');
  const [editing, setEditing] = useState(null);
  const staff = data?.staff || [];
  const partTime = staff.filter(item => item.employment_type === 'part_time').length;
  const hours = staff.reduce((sum, item) => sum + Number(item.hours_this_month || 0), 0);

  async function save(event) {
    event.preventDefault();
    try { await api(`/api/hr/staff/${editing.id}`, { method: 'PUT', body: JSON.stringify(editing) }); showToast('Staff profile updated.'); setEditing(null); reload(); }
    catch (requestError) { showToast(requestError.message, 'error'); }
  }

  if (loading && !data) return <PageState loading title="HR and staff" />;
  if (error && !data) return <PageState title="HR and staff unavailable" message={error} onRetry={reload} />;
  return <><section className="page-title-row"><div><p className="kicker">People operations</p><h2>HR & staff management</h2><p>Maintain employment type, job assignment and a practical attendance KPI view.</p></div></section><section className="admin-stat-strip hr-stat-strip" aria-label="Workforce summary"><div><span>Active staff</span><strong>{staff.filter(item => item.active).length}</strong><small>Enabled staff accounts</small></div><div><span>Part-time</span><strong>{partTime}</strong><small>Employment profiles</small></div><div><span>Completed shifts</span><strong>{staff.reduce((sum, item) => sum + Number(item.completed_shifts || 0), 0)}</strong><small>Current month</small></div><div><span>Hours recorded</span><strong>{hours.toFixed(1)}</strong><small>Completed shifts this month</small></div></section>
    <section className="panel records-panel"><div className="panel-heading"><div><p className="kicker">Workforce roster</p><h3>Staff profiles & KPI</h3></div><span className="record-count">{staff.length} staff</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Staff</th><th>Role</th><th>Employment</th><th>Job / department</th><th>Days</th><th>Completed</th><th>Hours</th><th><span className="sr-only">Edit</span></th></tr></thead><tbody>{staff.map(row => <tr key={row.id}><td><div className="member-cell"><span className="avatar avatar--small">{initials(row.name)}</span><span><strong>{row.name}</strong><small>{row.email}</small></span></div></td><td>{ROLE_LABELS[row.role]}</td><td><StatusBadge tone={row.employment_type === 'part_time' ? 'blue' : 'neutral'}>{EMPLOYMENT_LABELS[row.employment_type]}</StatusBadge></td><td><strong>{row.job_title || 'Not assigned'}</strong><small className="table-subline">{row.department || 'No department'}</small></td><td>{row.days_this_month}</td><td>{row.completed_shifts}</td><td>{row.hours_this_month}</td><td><div className="row-actions"><button onClick={() => setEditing({ ...row, start_date: dateForInput(row.start_date) })} aria-label={`Edit HR profile for ${row.name}`}><Pencil size={17} /></button></div></td></tr>)}</tbody></table></div></section>
    {editing && <div className="modal-layer"><button className="drawer-scrim" onClick={() => setEditing(null)} aria-label="Close HR form" /><form className="modal-card modal-card--wide" onSubmit={save}><header><div><p className="kicker">Staff profile</p><h2>{editing.name}</h2></div><button type="button" onClick={() => setEditing(null)} aria-label="Close"><X /></button></header><div className="form-grid"><Field label="Employment type"><select value={editing.employment_type} onChange={e => setEditing({ ...editing, employment_type: e.target.value })}>{Object.entries(EMPLOYMENT_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field label="Weekly target hours"><input type="number" min="1" max="168" step="0.5" value={editing.weekly_target_hours || 40} onChange={e => setEditing({ ...editing, weekly_target_hours: e.target.value })} /></Field><Field label="Job title"><input value={editing.job_title || ''} onChange={e => setEditing({ ...editing, job_title: e.target.value })} /></Field><Field label="Department"><input value={editing.department || ''} onChange={e => setEditing({ ...editing, department: e.target.value })} /></Field><Field label="Start date"><input type="date" value={editing.start_date || ''} onChange={e => setEditing({ ...editing, start_date: e.target.value })} /></Field></div><Field label="HR notes"><textarea rows="3" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} /></Field><footer><Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit">Save staff profile</Button></footer></form></div>}
  </>;
}

function UsersPage({ currentUser, showToast, onCurrentUserUpdated }) {
  const { data, loading, error, reload: load } = useApiResource('/api/users');
  const users = data?.users || [];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'data_management', password: '' });
  const [editingUser, setEditingUser] = useState(null);
  const [savingUser, setSavingUser] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const assignableRoles = Object.entries(ROLE_LABELS).filter(([key]) => currentUser.role === 'admin' || key !== 'admin');
  if (loading && !data) return <PageState loading title="Users and roles" />;
  if (error && !data) return <PageState title="Users and roles unavailable" message={error} onRetry={load} />;
  async function add(event) {
    event.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      showToast('User created. They must change the temporary password at first sign-in.');
      setOpen(false); setForm({ name: '', email: '', role: 'data_management', password: '' }); load();
    } catch (error) { showToast(error.message, 'error'); }
  }
  async function saveUser(event) {
    event.preventDefault();
    if (!editingUser) return;
    setSavingUser(true);
    const body = currentUser.role === 'admin'
      ? { name: editingUser.name, email: editingUser.email, role: editingUser.role, active: Boolean(editingUser.active) }
      : { role: editingUser.role };
    try {
      const result = await api(`/api/users/${editingUser.id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (Number(editingUser.id) === Number(currentUser.id)) onCurrentUserUpdated?.(result.user);
      showToast(`${editingUser.name}'s account was updated.`);
      setEditingUser(null); load();
    } catch (error) { showToast(error.message, 'error'); }
    finally { setSavingUser(false); }
  }
  function closeDelete() { setPendingDelete(null); setDeleteConfirmation(''); }
  async function deleteUser() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api(`/api/users/${pendingDelete.id}`, { method: 'DELETE' });
      showToast(`${pendingDelete.name}'s access was deleted. Historical records were retained.`);
      closeDelete(); load();
    } catch (error) { showToast(error.message, 'error'); }
    finally { setDeleting(false); }
  }
  return <><section className="page-title-row"><div><p className="kicker">Access control</p><h2>Users & roles</h2><p>Give each staff member only the access required for their work.</p></div><Button icon={Plus} onClick={() => setOpen(true)}>Add user</Button></section>
    <section className="panel"><div className="panel-heading"><div><p className="kicker">Active access</p><h3>Staff accounts</h3></div><StatusBadge>{users.length} users</StatusBadge></div><div className="table-scroll"><table className="data-table users-table"><thead><tr><th>User</th><th>Role</th><th>Access summary</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td><div className="member-cell"><span className="avatar avatar--small">{initials(user.name)}</span><span><strong>{user.name}{Number(user.id) === Number(currentUser.id) && <small className="current-user-label">You</small>}</strong><small>{user.email}</small></span></div></td><td><strong className="user-role-label">{ROLE_LABELS[user.role]}</strong></td><td>{user.access_summary}</td><td>{!user.active ? <StatusBadge>Inactive</StatusBadge> : user.must_change_password ? <StatusBadge tone="warning">Password change pending</StatusBadge> : <StatusBadge tone="success">Active</StatusBadge>}</td><td className="table-action-cell"><div className="user-row-actions"><button className="icon-action" type="button" onClick={() => setEditingUser({ id: user.id, name: user.name, email: user.email, role: user.role, active: Boolean(user.active) })} disabled={currentUser.role !== 'admin' && user.role === 'admin'} title={currentUser.role !== 'admin' && user.role === 'admin' ? 'Only an administrator can edit this account' : `Edit ${user.name}`} aria-label={`Edit ${user.name}`}><Pencil size={16} /></button>{currentUser.role === 'admin' && <button className="icon-action icon-action--danger" type="button" onClick={() => { setPendingDelete(user); setDeleteConfirmation(''); }} disabled={Number(user.id) === Number(currentUser.id)} title={Number(user.id) === Number(currentUser.id) ? 'You cannot delete your current account' : `Delete ${user.name}`} aria-label={`Delete ${user.name}`}><Trash2 size={16} /></button>}</div></td></tr>)}</tbody></table></div></section>
    <section className="role-grid">{Object.entries(ROLE_LABELS).map(([key, label]) => <article key={key}><span className="role-icon"><ShieldCheck size={18} /></span><h3>{label}</h3><p>{roleSummary(key)}</p></article>)}</section>
    {open && <div className="modal-layer"><button className="drawer-scrim" onClick={() => setOpen(false)} aria-label="Close" /><form className="modal-card" onSubmit={add} role="dialog" aria-modal="true" aria-labelledby="add-user-title"><header><div><p className="kicker">New account</p><h2 id="add-user-title">Add staff user</h2><p>The user will replace this temporary password at first sign-in.</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Close"><X /></button></header><Field label="Full name" required><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoComplete="off" required /></Field><Field label="Email" required><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} autoComplete="off" required /></Field><Field label="Role"><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{assignableRoles.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="Temporary password" hint="At least 12 characters. Share it through a secure channel."><input type="password" minLength="12" maxLength="200" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required /></Field><footer><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit">Create user</Button></footer></form></div>}
    {editingUser && <div className="modal-layer"><button className="drawer-scrim" onClick={() => setEditingUser(null)} aria-label="Close user editor" /><form className="modal-card user-edit-dialog" onSubmit={saveUser} role="dialog" aria-modal="true" aria-labelledby="edit-user-title"><header><div><p className="kicker">Account details</p><h2 id="edit-user-title">Edit staff user</h2><p>Update identity, access role and sign-in status for this staff account.</p></div><button type="button" onClick={() => setEditingUser(null)} aria-label="Close"><X /></button></header><div className="user-edit-identity"><span className="avatar">{initials(editingUser.name)}</span><span><strong>{editingUser.name || 'Staff account'}</strong><small>{editingUser.email || 'No email entered'}</small></span></div><div className="form-grid"><Field label="Full name" required hint={currentUser.role !== 'admin' ? 'Only administrators can change identity details.' : ''}><input value={editingUser.name} onChange={e => setEditingUser({ ...editingUser, name: e.target.value })} disabled={currentUser.role !== 'admin'} maxLength="160" required /></Field><Field label="Email address" required><input type="email" value={editingUser.email} onChange={e => setEditingUser({ ...editingUser, email: e.target.value })} disabled={currentUser.role !== 'admin'} maxLength="254" required /></Field><Field label="Role"><select value={editingUser.role} onChange={e => setEditingUser({ ...editingUser, role: e.target.value })} disabled={currentUser.role !== 'admin' && editingUser.role === 'admin'}>{(editingUser.role === 'admin' && currentUser.role !== 'admin' ? Object.entries(ROLE_LABELS) : assignableRoles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>{currentUser.role === 'admin' && <label className="account-status-control"><input type="checkbox" checked={editingUser.active} disabled={Number(editingUser.id) === Number(currentUser.id)} onChange={e => setEditingUser({ ...editingUser, active: e.target.checked })} /><span><strong>Account active</strong><small>{Number(editingUser.id) === Number(currentUser.id) ? 'You cannot deactivate the account you are currently using.' : 'Inactive users cannot sign in. Deactivation also ends their current sessions.'}</small></span><StatusBadge tone={editingUser.active ? 'success' : 'neutral'}>{editingUser.active ? 'Active' : 'Inactive'}</StatusBadge></label>}<footer><Button type="button" variant="secondary" onClick={() => setEditingUser(null)}>Cancel</Button><Button type="submit" icon={Pencil} disabled={savingUser || !editingUser.name.trim() || !editingUser.email.includes('@')}>{savingUser ? 'Saving changes…' : 'Save user changes'}</Button></footer></form></div>}
    {pendingDelete && <div className="modal-layer"><button className="drawer-scrim" onClick={closeDelete} aria-label="Close delete confirmation" /><section className="modal-card destructive-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-user-title"><header><div><span className="destructive-dialog__icon"><Trash2 /></span><p className="kicker">Permanent access removal</p><h2 id="delete-user-title">Delete {pendingDelete.name}?</h2></div><button type="button" onClick={closeDelete} aria-label="Close"><X /></button></header><p>This immediately signs the user out and removes their staff access. Attendance and audit history remain available for organizational records.</p><div className="destructive-dialog__identity"><span className="avatar avatar--small">{initials(pendingDelete.name)}</span><span><strong>{pendingDelete.name}</strong><small>{pendingDelete.email} · {ROLE_LABELS[pendingDelete.role]}</small></span></div><Field label={<>Type <strong>{pendingDelete.email}</strong> to confirm</>}><input value={deleteConfirmation} onChange={e => setDeleteConfirmation(e.target.value)} autoComplete="off" /></Field><footer><Button type="button" variant="secondary" onClick={closeDelete}>Cancel</Button><Button type="button" variant="danger" icon={Trash2} disabled={deleting || deleteConfirmation.trim().toLowerCase() !== pendingDelete.email.toLowerCase()} onClick={deleteUser}>{deleting ? 'Deleting…' : 'Delete user'}</Button></footer></section></div>}
  </>;
}

function roleSummary(role) {
  return ({ admin: 'Full administration, office settings, carding, finance, HR, users and all records.', chair: 'Organization oversight, records, carding, finance, HR, printing and user access.', secretary: 'Search member records and prepare forms without editing registry data.', hr: 'Staff profiles, part-time assignments and attendance KPI without member editing.', card_printing: 'Search, update photos, print member forms and maintain the daily carding ledger.', data_management: 'Import, search, create, correct and export member records.', finance: 'Record payments, daily carding, expenses, methods and finance summaries.' })[role];
}

function AuditPage({ showToast }) {
  const { data, loading, error, reload } = useApiResource('/api/audit');
  const rows = data?.activity || [];
  if (loading && !data) return <PageState loading title="Activity log" />;
  if (error && !data) return <PageState title="Activity log unavailable" message={error} onRetry={reload} />;
  return <><section className="page-title-row"><div><p className="kicker">Accountability</p><h2>Activity log</h2><p>Review who changed, imported or printed member records.</p></div></section><section className="panel"><div className="timeline timeline--wide">{rows.map(item => <div className="timeline-item" key={item.id}><span className="timeline-dot" /><div><strong>{item.action}</strong><p>{item.detail}</p><small>{item.actor_name} · {item.created_at} · {item.ip_address}</small></div></div>)}{!rows.length && <EmptyState icon={Activity} title="No recorded activity">Audited actions will appear here.</EmptyState>}</div></section></>;
}

function DataCarePage() {
  const items = [
    { icon: LockKeyhole, title: 'Least-privilege access', text: 'Only Chair, Card Printing and Data Management staff can edit member records.' },
    { icon: FileText, title: 'Consent & purpose', text: 'Keep a consent record and document why each field is needed for member services.' },
    { icon: Archive, title: 'Retention review', text: 'Review inactive records on a defined schedule. Do not keep sensitive data indefinitely.' },
    { icon: Download, title: 'Encrypted backups', text: 'Use PostgreSQL point-in-time backups and protect member uploads with the same tested recovery plan.' },
    { icon: Activity, title: 'Audit changes', text: 'Use the activity log to review edits, imports, exports and printing.' },
    { icon: HeartHandshake, title: 'Dignity by design', text: 'Avoid exposing photos or personal details on summary screens when they are not needed.' }
  ];
  return <><section className="page-title-row"><div><p className="kicker">Safeguarding</p><h2>Data care & continuity</h2><p>Practical controls for sensitive refugee and member information.</p></div></section><section className="care-callout"><ShieldCheck size={26} /><div><h3>Member data is confidential.</h3><p>UNHCR branding on a printed form does not make this system an official UNHCR database. MRO remains responsible for access, consent, accuracy and safe retention.</p></div></section><section className="care-grid">{items.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={20} /><h3>{title}</h3><p>{text}</p></article>)}</section></>;
}

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('mro-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [session, setSession] = useState(undefined);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const navigate = useNavigate();
  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => { api('/api/auth/session').then(setSession).catch(() => setSession(null)); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem('mro-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#08090a' : '#ffffff');
  }, [theme]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } finally { setSession(null); navigate('/login', { replace: true }); } }
  if (session === undefined) return <ThemeContext.Provider value={{ theme, setTheme }}><div className="app-loading"><img src="/assets/mro-logo.png" alt="MRO" /><RefreshCw className="spin" /></div></ThemeContext.Provider>;
  return <ThemeContext.Provider value={{ theme, setTheme }}>
    <Routes>
      <Route path="/" element={<LandingPage session={session} />} />
      <Route path="/about" element={<AboutPage session={session} />} />
      <Route path="/faq" element={<FaqPage session={session} />} />
      <Route path="/login" element={session ? <Navigate to={session.must_change_password ? '/change-password' : '/app'} replace /> : <LoginPage onLogin={setSession} />} />
      <Route path="/change-password" element={!session ? <Navigate to="/login" replace /> : session.must_change_password ? <FirstLoginPasswordPage user={session} onChanged={setSession} onLogout={logout} /> : <Navigate to="/app" replace />} />
      <Route path="/app" element={!session ? <Navigate to="/login" replace /> : session.must_change_password ? <Navigate to="/change-password" replace /> : <AppShell user={session} onLogout={logout}><Outlet /></AppShell>}>
        <Route index element={<DashboardPage user={session} showToast={showToast} />} />
        <Route path="admin" element={can(session, 'users:manage') ? <AdminDashboardPage user={session} showToast={showToast} /> : <Navigate to="/app" replace />} />
        <Route path="members" element={can(session, 'members:view') ? <MembersPage user={session} showToast={showToast} /> : <Navigate to="/app" replace />} />
        <Route path="printing" element={<Navigate to="/app/members" replace />} />
        <Route path="carding" element={can(session, 'carding:view') ? <CardingPage showToast={showToast} /> : <Navigate to="/app" replace />} />
        <Route path="finance" element={can(session, 'finance:view') ? <FinancePage showToast={showToast} /> : <Navigate to="/app" replace />} />
        <Route path="hr" element={can(session, 'hr:view') ? <HrPage showToast={showToast} /> : <Navigate to="/app" replace />} />
        <Route path="attendance" element={<AttendancePage showToast={showToast} />} />
        <Route path="users" element={can(session, 'users:manage') ? <UsersPage currentUser={session} showToast={showToast} onCurrentUserUpdated={setSession} /> : <Navigate to="/app" replace />} />
        <Route path="audit" element={can(session, 'audit:view') ? <AuditPage showToast={showToast} /> : <Navigate to="/app" replace />} />
        <Route path="data-care" element={can(session, 'members:view') ? <DataCarePage /> : <Navigate to="/app" replace />} />
        <Route path="settings" element={can(session, 'settings:manage') ? <OfficeSettingsPage showToast={showToast} /> : <Navigate to="/app" replace />} />
        <Route path="profile" element={<ProfilePage user={session} showToast={showToast} />} />
        <Route path="*" element={<NotFoundPage session={session} app />} />
      </Route>
      <Route path="*" element={<NotFoundPage session={session} />} />
    </Routes>
    <Toast toast={toast} onClose={() => setToast(null)} />
  </ThemeContext.Provider>;
}
