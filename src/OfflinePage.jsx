import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Archive, ArrowRight, CheckCircle2, LockKeyhole, Plus, RefreshCw, ShieldCheck, Trash2, Wifi, WifiOff } from 'lucide-react';
import { api } from './api';
import { createVault, deleteOfflineRecord, listVaults, readOfflineRecords, replaceOfflineRecord, saveOfflineRecord, unlockVault } from './offline-vault';

export default function OfflinePage({ session, showToast, MemberDrawer, emptyMember }) {
  const [vaults, setVaults] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [vault, setVault] = useState(null);
  const [passphrase, setPassphrase] = useState('');
  const [setupPassphrase, setSetupPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [records, setRecords] = useState([]);
  const [recordErrors, setRecordErrors] = useState({});
  const [pageError, setPageError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(null);
  const [shellReady, setShellReady] = useState(Boolean(navigator.serviceWorker?.controller));
  const [editing, setEditing] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [syncTick, setSyncTick] = useState(0);
  const syncingRef = useRef(false);
  const resyncAfterSave = useRef(false);
  const canSetUp = session?.permissions?.includes('members:edit') && !session?.must_change_password;
  const hasOwnVault = vaults.some(item => item.userId === String(session?.id));

  useEffect(() => {
    listVaults().then(items => {
      setVaults(items);
      setSelectedId(current => current || items.find(item => item.userId === String(session?.id))?.userId || items[0]?.userId || '');
    }).catch(error => setPageError(`Offline storage could not be opened: ${error.message}`));
  }, [session?.id]);

  useEffect(() => {
    let active = true;
    const checkConnection = async () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
        const health = response.ok && response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
        if (active) setOnline(response.ok && health?.status === 'ok');
      } catch { if (active) setOnline(false); }
      finally { window.clearTimeout(timer); }
    };
    window.addEventListener('online', checkConnection);
    window.addEventListener('offline', checkConnection);
    const interval = window.setInterval(checkConnection, 15000);
    checkConnection();
    if (navigator.serviceWorker) navigator.serviceWorker.ready.then(() => { if (active) setShellReady(true); }).catch(() => {});
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('online', checkConnection); window.removeEventListener('offline', checkConnection); };
  }, []);

  const refreshRecords = useCallback(async currentVault => {
    setRecords((await readOfflineRecords(currentVault.userId, currentVault.key)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }, []);

  const syncRecords = useCallback(async () => {
    if (!vault || !online || syncingRef.current) return;
    syncingRef.current = true; setSyncing(true); setSyncError('');
    try {
      const queued = await readOfflineRecords(vault.userId, vault.key);
      if (!queued.length) return;
      const account = await api('/api/auth/session');
      if (String(account.id) !== vault.userId || !account.permissions?.includes('members:edit') || account.must_change_password) {
        throw new Error('Sign in with the same authorized account that created this offline vault.');
      }
      let completed = 0;
      const errors = {};
      for (const record of queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        try {
          await api('/api/members/offline-sync', { method: 'POST', body: JSON.stringify({ operationId: record.id, fields: record.fields }) });
          await deleteOfflineRecord(record.id);
          completed += 1;
        } catch (error) {
          if (error.status === 400 || error.status === 409) { errors[record.id] = error.message; continue; }
          throw error;
        }
      }
      setRecordErrors(errors);
      await refreshRecords(vault);
      if (completed) showToast(`${completed} offline ${completed === 1 ? 'registration' : 'registrations'} synced.`);
      if (Object.keys(errors).length) setSyncError('Some registrations need review before they can sync.');
    } catch (error) {
      setSyncError(error.status === 401 ? 'Sign in again to sync saved registrations.' : error.message || 'Sync could not connect. The records remain safely queued.');
    } finally {
      syncingRef.current = false; setSyncing(false);
      if (resyncAfterSave.current) { resyncAfterSave.current = false; setSyncTick(value => value + 1); }
    }
  }, [vault, online, refreshRecords, showToast]);

  useEffect(() => { if (vault && online) syncRecords(); }, [vault, online, syncTick, syncRecords]);

  async function setUp(event) {
    event.preventDefault(); setPageError('');
    if (setupPassphrase !== confirmation) { setPageError('The passphrases do not match.'); return; }
    setBusy(true);
    try {
      const current = await createVault(session, setupPassphrase);
      setVault(current); setSelectedId(current.userId); setSetupPassphrase(''); setConfirmation('');
      setVaults(await listVaults()); await refreshRecords(current);
      showToast('Offline collection is ready on this device.');
    } catch (error) { setPageError(error.message); }
    finally { setBusy(false); }
  }

  async function unlock(event) {
    event.preventDefault(); setPageError(''); setBusy(true);
    try {
      const current = await unlockVault(selectedId, passphrase);
      await refreshRecords(current);
      setVault(current); setPassphrase('');
    } catch (error) { setPageError(error.message); }
    finally { setBusy(false); }
  }

  async function save(formData) {
    if (!vault) throw new Error('Unlock the offline vault before saving.');
    const fields = Object.fromEntries(formData.entries());
    if (!String(fields.reference || '').trim() || !String(fields.fullname || '').trim()) throw new Error('MRO status number and full name are required.');
    if (editingId) await replaceOfflineRecord(editingId, vault.userId, vault.key, fields);
    else await saveOfflineRecord(vault.userId, vault.key, fields);
    await refreshRecords(vault);
    setRecordErrors(current => { const next = { ...current }; delete next[editingId]; return next; });
    setEditing(null); setEditingId(null);
    showToast('Registration saved on this device. It is pending sync.');
    if (online) {
      if (syncingRef.current) resyncAfterSave.current = true;
      else setSyncTick(value => value + 1);
    }
  }

  function edit(record) {
    if (syncing) return;
    setEditingId(record.id);
    setEditing({ ...emptyMember, ...record.fields, family_members_data: JSON.parse(record.fields.family_members_data || '[]') });
  }

  async function remove(record) {
    if (syncing) return;
    if (!window.confirm(`Permanently discard the unsynced registration for ${record.fields.fullname}?`)) return;
    try {
      await deleteOfflineRecord(record.id);
      await refreshRecords(vault);
      setRecordErrors(current => { const next = { ...current }; delete next[record.id]; return next; });
    } catch (error) { setPageError(error.message); }
  }

  function lock() {
    if (syncing) return;
    setVault(null); setRecords([]); setRecordErrors({}); setEditing(null); setPassphrase('');
  }

  return <main className="offline-page">
    <header className="offline-header"><NavLink to={session ? '/app/members' : '/login'} className="text-link"><ArrowRight size={16} className="offline-back-icon" /> {session ? 'Member records' : 'Staff sign in'}</NavLink><div className="offline-connection" role="status">{online === null ? <RefreshCw size={17} className="spin" /> : online ? <Wifi size={17} /> : <WifiOff size={17} />}{online === null ? 'Checking connection…' : online ? 'Server available' : 'Server unavailable'}</div></header>
    <div className="offline-layout">
      <section className="offline-intro"><span className="offline-intro__icon"><Archive size={27} /></span><p className="kicker">Field registration</p><h1>Collect now. Sync when connected.</h1><p>New member registrations are encrypted on this device until the same staff account signs in and the offline vault is unlocked. Photos and existing record edits are not available offline.</p><div className="offline-steps"><div><strong>01</strong><span>Set up an offline passphrase while online.</span></div><div><strong>02</strong><span>Record new members without internet.</span></div><div><strong>03</strong><span>Reconnect, unlock and review sync results.</span></div></div></section>
      <section className="offline-workspace">
        {!shellReady && <div className="offline-notice" role="status">Offline access is preparing. Keep this page open while connected, then reload once before going into the field.</div>}
        {pageError && <div className="form-alert" role="alert">{pageError}</div>}
        {!vault && <div className="offline-panel"><div className="offline-panel__heading"><LockKeyhole size={21} /><div><h2>{vaults.length ? 'Unlock offline records' : 'Prepare this device'}</h2><p>{vaults.length ? 'Choose your staff account and enter its offline passphrase.' : canSetUp ? `Create an encrypted vault for ${session.email}.` : 'Sign in once to create an encrypted offline vault.'}</p></div></div>
          {vaults.length > 0 && <form onSubmit={unlock} className="offline-form"><label>Staff account<select value={selectedId} onChange={event => setSelectedId(event.target.value)}>{vaults.map(item => <option key={item.userId} value={item.userId}>{item.email}</option>)}</select></label><label>Offline passphrase<input type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} autoComplete="off" required /></label><button className="button" disabled={busy || !selectedId}>{busy ? 'Unlocking…' : 'Unlock queue'}</button></form>}
          {canSetUp && !hasOwnVault && <form onSubmit={setUp} className="offline-form offline-form--setup"><h3>{vaults.length ? 'Set up this account on this device' : 'Create an offline passphrase'}</h3><p>Use at least 16 characters, such as several unrelated words. This passphrase cannot be recovered; unsynced records are lost if it is forgotten.</p><label>Offline passphrase<input type="password" minLength="16" value={setupPassphrase} onChange={event => setSetupPassphrase(event.target.value)} autoComplete="new-password" required /></label><label>Confirm passphrase<input type="password" minLength="16" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" required /></label><button className="button" disabled={busy || !shellReady || !online}>{busy ? 'Preparing…' : 'Prepare offline access'}</button></form>}
          {!canSetUp && !vaults.length && <p className="offline-help"><NavLink to="/login">Sign in with a member-editing account</NavLink> while connected to prepare this device.</p>}
        </div>}
        {vault && <><div className="offline-panel"><div className="offline-panel__heading"><ShieldCheck size={22} /><div><h2>Offline queue</h2><p>{records.length} {records.length === 1 ? 'registration' : 'registrations'} waiting on this device</p></div></div><div className="offline-actions"><button className="button" onClick={() => { setEditingId(null); setEditing({ ...emptyMember }); }}><Plus size={17} /> New registration</button><button className="button button--secondary" onClick={() => setSyncTick(value => value + 1)} disabled={!online || syncing || !records.length}><RefreshCw size={16} className={syncing ? 'spin' : ''} />{syncing ? 'Syncing…' : 'Sync now'}</button><button className="button button--secondary" onClick={lock} disabled={syncing}><LockKeyhole size={16} /> Lock</button></div>
          {!vault.persistent && <div className="offline-notice" role="status">This browser has not granted persistent storage. Keep this device’s browser data and sync queued records as soon as possible.</div>}
          {syncError && <div className="form-alert" role="alert">{syncError} {syncError.includes('Sign in') && <NavLink to="/login">Sign in</NavLink>}</div>}
          {!records.length && <div className="offline-empty"><CheckCircle2 size={24} /><strong>Queue is clear</strong><span>New registrations saved here will appear until the server confirms them.</span></div>}
          {!!records.length && <ul className="offline-records">{records.map(record => <li key={record.id}><div><strong>{record.fields.fullname}</strong><span>MRO {record.fields.reference} · saved {new Date(record.createdAt).toLocaleString()}</span>{recordErrors[record.id] && <small role="alert">Needs review: {recordErrors[record.id]}</small>}</div><div className="offline-record-actions">{recordErrors[record.id] && <button className="text-link" onClick={() => edit(record)} disabled={syncing}>Edit</button>}<button className="text-link offline-discard" onClick={() => remove(record)} disabled={syncing} aria-label={`Discard ${record.fields.fullname}`}><Trash2 size={16} /> Discard</button></div></li>)}</ul>}
        </div><p className="offline-help">Sync starts when this page is open, the vault is unlocked and a connection returns. If the page was closed, open it and unlock the vault to resume. Keep the device and browser data until the queue is clear.</p></>}
      </section>
    </div>
    {editing && <MemberDrawer member={editing} canEdit canPrint={false} canDelete={false} allowPhoto={false} offlineMode saveLabel="Save offline" onSave={save} onClose={() => { setEditing(null); setEditingId(null); }} />}
  </main>;
}
