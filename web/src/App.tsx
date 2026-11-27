import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as fog from './fog'
import { chatAvatar, chatTitle, isMuted, msgStatus, personName, SAVED, shortId, timerLabel, TIMERS, useFog, type Chat, type Msg } from './fog'
import { ChatPane } from './chat'
import { CallScreen } from './callscreen'
import { renderSVG } from 'uqr'
import { fmtTime, snippet, Ticks } from './bubble'
import { avatarFrom, download, SERVER, useLocalUrl } from './media'
import * as db from './db'
import { BotDialogs } from './botui'
import { LinkCheck } from './markdown'
import { Avatar, BotBadge, Button, copy, Dialog, Drawer, Icon, IconButton, Menu, MenuItem, Row, Section, Spinner, Toaster, Toggle, usePressMenu, type MenuAt } from './ui'
function fmtListTime(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return fmtTime(ts)
  if (now.getTime() - ts < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

// ---------- app ----------
export function App() {
  const phase = useFog((s) => s.phase)
  return (
    <>
      {phase === 'loading' ? (
        <div className="fogbank h-full" />
      ) : phase === 'locked' ? (
        <Locked />
      ) : phase === 'unlock' ? (
        <LockScreen />
      ) : phase === 'terms' ? (
        <HostedTerms />
      ) : phase === 'delete' || phase === 'deleted' ? (
        <DeleteOnline done={phase === 'deleted'} />
      ) : phase === 'welcome' ? (
        <Onboarding />
      ) : phase === 'username' ? (
        <UsernameStep />
      ) : (
        <Main />
      )}
      {phase === 'app' && <CallScreen />}
      {phase === 'app' && <BotDialogs />}
      <LinkCheck />
      <Toaster />
    </>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="fogbank flex min-h-full items-center justify-center p-4">
      <div className="fade-in w-full max-w-md rounded-3xl bg-panel p-8 shadow-[0_30px_80px_-30px_rgba(20,30,40,0.35)]">{children}</div>
    </div>
  )
}

function PolicyLink({ path, children }: { path: string; children: ReactNode }) {
  const url = new URL(path, SERVER).href
  return <a className="underline" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => fog.externalClick(e, url)}>{children}</a>
}

function HostedTerms() {
  const [adult, setAdult] = useState(false)
  return (
    <Centered>
      <h1 className="text-2xl font-bold">Use Fog on getfog.org</h1>
      <p className="mt-3">Read the <PolicyLink path="/terms/">Terms of Use</PolicyLink> before continuing. The <PolicyLink path="/privacy/">Privacy Policy</PolicyLink> explains how Fog handles your data.</p>
      <label className="my-5 flex items-center gap-3"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> I am 18 or older.</label>
      <Button disabled={!adult} onClick={() => fog.acceptTerms().catch(() => fog.toast("Couldn't save your acceptance on this device. Try again."))}>Agree to the Terms and continue</Button>
      <button className="mt-5 block text-sm underline" onClick={fog.openAccountDeletion}>Delete an existing account</button>
    </Centered>
  )
}

function DeleteOnline({ done }: { done: boolean }) {
  const me = useFog((s) => s.me)
  const [phrase, setPhrase] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const localDeletionFailed = useFog((s) => s.localDeletionFailed)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const words = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
  const submit = async () => {
    setBusy(true)
    setError('')
    try { await fog.deleteFromBrowser(words) }
    catch (e) { setError((e as Error).message) }
    finally { setPhrase(''); setBusy(false) }
  }
  return (
    <Centered>
      <h1 className="text-2xl font-bold">{done ? 'Account deleted' : 'Delete your Fog account'}</h1>
      {done ? <p className="mt-3">The server confirmed deletion. {localDeletionFailed ? 'Local data could not be erased. Clear Fog’s data in your browser or device settings.' : 'You can close this page.'}</p> : <>
        {me && <p className="mt-3 break-all">Account on this device: {me.username ? '@' + me.username : me.id}</p>}
        {!me?.main && <label className="mt-5 block">Your recovery phrase
          <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} className="mt-2 w-full rounded-lg border border-line bg-raised p-3" />
          <span className="mt-2 block text-sm text-muted">Fog uses your words on this device to prove account ownership. Never send them to support.</span>
        </label>}
        <p className="mt-4">Deletion removes your account, username and current chat backup from {SERVER.host}. Delivered messages can remain with recipients. <PolicyLink path="/delete/">See what is kept.</PolicyLink></p>
        <label className="my-5 flex items-start gap-3"><input className="mt-1" type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I understand that deleting this account is permanent.</label>
        <Button kind="danger" disabled={busy || !confirmed || (!me?.main && !fog.validPhrase(words))} onClick={submit}>{busy ? 'Deleting…' : 'Permanently delete account'}</Button>
        {error && <p className="mt-3 text-danger" role="alert">{error}</p>}
        <button className="mt-5 block text-sm underline" disabled={busy} onClick={() => { const url = new URL(location.href); url.searchParams.delete('delete'); location.replace(url.href) }}>Cancel</button>
      </>}
    </Centered>
  )
}

function Locked() {
  return (
    <Centered>
      <h1 className="text-2xl font-bold">Fog is open in another tab</h1>
      <p className="mt-2 text-muted">Only one tab can hold your keys at a time. Close the other tab and Fog continues here.</p>
    </Centered>
  )
}

function LockScreen() {
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [passkey, setPasskey] = useState(false)
  const [forgot, setForgot] = useState(false)
  useEffect(() => void db.passkeyEnabled().then(setPasskey), [])
  const done = () => fog.unlocked()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await db.unlockWithPasscode(code)
      done()
    } catch {
      setErr('Wrong passcode. Try again.')
      setCode('')
      setBusy(false)
    }
  }
  return (
    <Centered>
      <div className="flex flex-col items-center text-center">
        <span className="grid size-16 place-items-center rounded-2xl bg-lamp text-lamp-ink">
          <Icon name="lockOn" className="size-8" />
        </span>
        <h1 className="mt-4 text-2xl font-bold">Fog is locked</h1>
        <p className="mt-1 text-muted">Your messages are encrypted on this device.</p>
      </div>
      <form onSubmit={submit} className="mt-6">
        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          autoComplete="current-password"
          placeholder="Passcode"
          aria-label="Passcode"
          aria-invalid={!!err}
          className={`h-14 w-full rounded-2xl border bg-raised px-4 text-center text-lg tracking-widest outline-none focus:border-lamp ${err ? 'border-danger' : 'border-line'}`}
        />
        <p role="alert" className="mt-1 h-5 text-center text-sm text-danger">
          {err}
        </p>
        <Button className="mt-2 w-full" disabled={!code || busy}>
          {busy ? <Spinner /> : 'Unlock'}
        </Button>
      </form>
      {passkey && (
        <Button
          kind="soft"
          className="mt-2 w-full"
          onClick={async () => {
            try {
              await db.unlockWithPasskey()
              done()
            } catch {
              setErr("Passkey didn't work. Use your passcode instead.")
            }
          }}
        >
          <span className="flex items-center justify-center gap-2">
            <Icon name="key" className="size-5" /> Unlock with passkey
          </span>
        </Button>
      )}
      <button onClick={() => setForgot(true)} className="mt-4 w-full text-sm text-muted hover:text-ink">
        Forgot your passcode?
      </button>
      {forgot && (
        <Dialog
          title="Reset Fog on this device?"
          onClose={() => setForgot(false)}
          actions={
            <>
              <Button kind="ghost" onClick={() => setForgot(false)}>
                Cancel
              </Button>
              <Button kind="danger" onClick={fog.logout}>
                Erase and start over
              </Button>
            </>
          }
        >
          Without the passcode, the data on this device can't be decrypted. You can erase it and restore your account with your 24-word recovery phrase. Messages stored only on this device will be lost.
        </Dialog>
      )}
    </Centered>
  )
}

/** App lock settings: passcode, passkey, auto-lock. */
function AppLockDialog({ onClose }: { onClose: () => void }) {
  const settings = useFog((s) => s.settings)
  const [on, setOn] = useState<boolean | null>(null)
  const [hasPasskey, setHasPasskey] = useState(false)
  const [step, setStep] = useState<'main' | 'set' | 'autolock'>('main')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = () => Promise.all([db.lockEnabled(), db.passkeyEnabled()]).then(([l, p]) => (setOn(l), setHasPasskey(p)))
  useEffect(() => void refresh(), [])
  const bits = db.passcodeBits(a)
  const ok = a.length >= 8 && bits >= db.MIN_PASSCODE_BITS && a === b
  if (on === null) return null
  if (step === 'autolock')
    return (
      <Choice
        title="Auto-lock"
        options={[
          [1, 'After 1 minute'],
          [5, 'After 5 minutes'],
          [60, 'After 1 hour'],
          [0, 'Never (only when I lock it)'],
        ]}
        value={settings.autoLock}
        onPick={(v) => fog.updateSettings({ autoLock: v })}
        onClose={() => setStep('main')}
      />
    )
  if (step === 'set' || !on)
    return (
      <Dialog
        title={on ? 'Change passcode' : 'Turn on app lock'}
        onClose={onClose}
        actions={
          <>
            <Button kind="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!ok || busy}
              onClick={async () => {
                setBusy(true)
                if (on) await db.changePasscode(a)
                else await db.enableLock(a)
                fog.toast(on ? 'Passcode changed' : 'App lock is on')
                setBusy(false)
                setA('')
                setB('')
                setStep('main')
                refresh()
              }}
            >
              {busy ? <Spinner /> : on ? 'Change' : 'Turn on'}
            </Button>
          </>
        }
      >
        <p>Everything Fog stores on this device gets encrypted with your passcode. If you forget it, you'll need your recovery phrase.</p>
        <input type="password" autoFocus autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} placeholder="New passcode (8+ characters)" aria-label="New passcode" className="mt-4 h-12 w-full rounded-xl border border-line bg-raised px-4 text-base text-ink outline-none focus:border-lamp" />
        {a && (
          <div className="mt-2" aria-live="polite">
            <div className="flex h-1.5 gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className={`flex-1 rounded-full ${bits >= [20, db.MIN_PASSCODE_BITS, 60][i] ? (bits >= 60 ? 'bg-emerald-500' : bits >= db.MIN_PASSCODE_BITS ? 'bg-lamp' : 'bg-danger') : 'bg-line'}`} />
              ))}
            </div>
            <p className={`mt-1 text-sm ${bits >= db.MIN_PASSCODE_BITS && a.length >= 8 ? 'text-muted' : 'text-danger'}`}>
              {a.length < 8 ? 'Use at least 8 characters.' : bits < db.MIN_PASSCODE_BITS ? 'Too easy to guess. Add length or mix in letters and symbols.' : bits < 60 ? 'Good.' : 'Strong.'}
            </p>
          </div>
        )}
        <input type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} placeholder="Repeat passcode" aria-label="Repeat passcode" className="mt-2 h-12 w-full rounded-xl border border-line bg-raised px-4 text-base text-ink outline-none focus:border-lamp" />
        {b && a !== b && <p className="mt-1 text-sm text-danger">Passcodes don't match.</p>}
      </Dialog>
    )
  return (
    <Dialog title="App lock" onClose={onClose} actions={<Button onClick={onClose}>Done</Button>}>
      <div className="-mx-3 mt-1 text-ink">
        <Row icon="timer" title="Auto-lock" sub={settings.autoLock ? `After ${settings.autoLock === 60 ? '1 hour' : `${settings.autoLock} minute${settings.autoLock > 1 ? 's' : ''}`} without activity` : 'Never'} onClick={() => setStep('autolock')} />
        {db.passkeySupported() && (
          <Row
            icon="key"
            title={hasPasskey ? 'Passkey unlock is on' : 'Unlock with a passkey'}
            sub={hasPasskey ? 'Tap to remove' : 'Touch ID, Face ID, Windows Hello or a security key'}
            onClick={async () => {
              try {
                if (hasPasskey) await db.removePasskey()
                else await db.addPasskey()
                fog.toast(hasPasskey ? 'Passkey removed' : 'Passkey added')
                refresh()
              } catch {
                fog.toast("This browser or device can't use a passkey for app lock")
              }
            }}
          />
        )}
        <Row icon="pencil" title="Change passcode" onClick={() => setStep('set')} />
        <Row icon="lockOn" title="Lock now" onClick={fog.lockNow} />
        <Row
          icon="close"
          title={<span className="text-danger">Turn off app lock</span>}
          onClick={async () => {
            await db.disableLock()
            fog.toast('App lock is off')
            onClose()
          }}
        />
      </div>
    </Dialog>
  )
}

function Onboarding() {
  const [step, setStep] = useState<'welcome' | 'create' | 'restore' | 'link'>('welcome')
  const [unlinked] = useState(() => fog.wasUnlinked())
  if (step === 'create') return <CreateStep onBack={() => setStep('welcome')} />
  if (step === 'restore') return <RestoreStep onBack={() => setStep('welcome')} />
  if (step === 'link') return <LinkStep onBack={() => setStep('welcome')} />
  return (
    <div className="fogbank flex min-h-full flex-col items-center justify-center px-6 text-center">
      <h1 className="wordmark text-[clamp(96px,22vw,180px)] leading-none font-[850] tracking-[-0.06em]">fog</h1>
      <p className="mt-8 max-w-sm text-lg text-muted">Private messaging with no phone number, email or password. Your account is a key that only you hold.</p>
      {unlinked && (
        <p role="status" className="mt-6 max-w-sm rounded-2xl bg-raised px-4 py-3 text-sm">
          This device was unlinked from your account, and everything Fog stored on it was erased.
        </p>
      )}
      <div className="mt-10 flex w-full max-w-xs flex-col gap-2">
        <Button onClick={() => setStep('create')}>Create account</Button>
        <Button kind="ghost" onClick={() => setStep('link')}>
          Link to an existing account
        </Button>
        <Button kind="ghost" onClick={() => setStep('restore')}>
          I have a recovery phrase
        </Button>
      </div>
      <p className="mt-10 flex items-center gap-1.5 text-sm text-muted">
        <Icon name="lock" className="size-4" /> End-to-end encrypted with the Signal protocol
      </p>
      <style>{`.wordmark{animation:clear 1.6s cubic-bezier(.2,.7,.2,1) both}@keyframes clear{from{filter:blur(18px);opacity:.15;letter-spacing:.05em}}`}</style>
    </div>
  )
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="-ml-2 mb-4 flex items-center text-sm text-muted hover:text-ink">
      <Icon name="back" className="size-5" /> Back
    </button>
  )
}

function CreateStep({ onBack }: { onBack: () => void }) {
  const phrase = useMemo(() => fog.newPhrase(), [])
  const [shown, setShown] = useState(false)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Centered>
      <Back onClick={onBack} />
      <h1 className="text-2xl font-bold">Your recovery phrase</h1>
      <p className="mt-2 text-muted">These 24 words are your account. Anyone who has them can read your messages. If you lose them, nobody can recover your account.</p>
      <div className="relative mt-6">
        <ol className={`grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-raised p-4 sm:grid-cols-3 ${shown ? '' : 'fogged'}`}>
          {phrase.split(' ').map((w, i) => (
            <li key={i} className="flex gap-2 text-[15px]">
              <span className="w-5 text-right text-muted tabular-nums">{i + 1}</span>
              <span className="font-medium">{w}</span>
            </li>
          ))}
        </ol>
        {!shown && (
          <button onClick={() => setShown(true)} className="absolute inset-0 grid place-items-center rounded-2xl font-semibold">
            <span className="flex items-center gap-2 rounded-full bg-panel px-4 py-2 shadow">
              <Icon name="eye" className="size-5" /> Show words
            </span>
          </button>
        )}
      </div>
      {shown && (
        <button onClick={() => copy(phrase, 'Recovery phrase copied')} className="mt-2 flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          <Icon name="copy" className="size-4" /> Copy words
        </button>
      )}
      <label className="mt-6 flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={!shown} className="mt-0.5 size-5 accent-[var(--lamp)]" />
        <span>I've written these words down somewhere safe</span>
      </label>
      {err && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {err}
        </p>
      )}
      <Button
        className="mt-6 w-full"
        disabled={!saved || busy}
        onClick={() => (setBusy(true), setErr(null), fog.createAccount(phrase).catch((e) => (setErr(e.message), setBusy(false))))}
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <Spinner /> Creating your keys
          </span>
        ) : (
          'Continue'
        )}
      </Button>
    </Centered>
  )
}

function RestoreStep({ onBack }: { onBack: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const valid = fog.validPhrase(text.toLowerCase())
  return (
    <Centered>
      <Back onClick={onBack} />
      <h1 className="text-2xl font-bold">Restore your account</h1>
      <p className="mt-2 text-muted">
        Enter your 24-word recovery phrase. This becomes your main device, any linked devices are signed out, and your chats come back from your latest backup if backups were on. To add a device instead, use{' '}
        <span className="font-medium text-ink">Link to an existing account</span>.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        autoFocus
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        placeholder="word1 word2 word3 …"
        className="mt-6 w-full resize-none rounded-2xl border border-line bg-raised p-4 text-base outline-none focus:border-lamp"
      />
      <p className={`mt-1 text-sm ${words >= 24 && !valid ? 'text-danger' : 'text-muted'}`}>
        {words >= 24 && !valid ? "That phrase isn't valid. Check each word's spelling." : `${words} of 24 words`}
      </p>
      {err && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {err}
        </p>
      )}
      <Button
        className="mt-6 w-full"
        disabled={!valid || busy}
        onClick={() => (setBusy(true), setErr(null), fog.createAccount(text.toLowerCase()).catch((e) => (setErr(e.message), setBusy(false))))}
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <Spinner /> Restoring
          </span>
        ) : (
          'Restore account'
        )}
      </Button>
    </Centered>
  )
}

/** New device: show a code for the main device to scan, then receive the account and chat history. */
function LinkStep({ onBack }: { onBack: () => void }) {
  const [code, setCode] = useState<string | null>(null)
  const [step, setStep] = useState<'waiting' | 'confirm' | 'approve' | 'linking' | 'history'>('waiting')
  const [check, setCheck] = useState<{ code: string; answer: (ok: boolean) => void } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const ctl = new AbortController()
    setErr(null)
    setCode(null)
    setStep('waiting')
    const confirm = (c: string) => new Promise<boolean>((answer) => (setCheck({ code: c, answer }), setStep('confirm')))
    fog
      .linkThisDevice(setCode, setStep, ctl.signal, confirm)
      .catch((e) => !ctl.signal.aborted && setErr(e.message === 'expired' ? 'This code expired.' : e.message === 'cancelled' ? 'Linking cancelled. Nothing was copied to this device.' : e.message))
    return () => ctl.abort()
  }, [attempt])
  const qr = useMemo(() => code && `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(code, { border: 2, blackColor: '#15202b', whiteColor: '#ffffff' }))}`, [code])
  if (step === 'confirm' && check && !err)
    return (
      <Centered>
        <h1 className="text-2xl font-bold">Check the code</h1>
        <p className="mt-2 text-muted">Your main device is showing a code. Make sure it's the same as this one before you continue.</p>
        <p className="mt-6 text-center font-mono text-4xl font-semibold tracking-wider tabular-nums">{check.code}</p>
        <Button className="mt-8 w-full" onClick={() => check.answer(true)}>
          It matches
        </Button>
        <Button kind="ghost" className="mt-2 w-full" onClick={() => check.answer(false)}>
          It doesn't match
        </Button>
      </Centered>
    )
  return (
    <Centered>
      <Back onClick={onBack} />
      <h1 className="text-2xl font-bold">Link to your account</h1>
      <p className="mt-2 text-muted">
        On your main device (the one with your recovery phrase), open <span className="font-medium text-ink">Settings → Devices → Link a device</span> and scan this code.
      </p>
      <div className="mx-auto mt-6 grid aspect-square w-full max-w-72 place-items-center rounded-3xl bg-white p-4 shadow-sm">
        {step === 'waiting' && qr && !err ? <img src={qr} alt="Link code" className="size-full" /> : err ? <Icon name="qr" className="size-16 text-[#9aa5b1]" /> : <Spinner />}
      </div>
      {step !== 'waiting' && !err && (
        <p role="status" className="mt-4 text-center font-medium">
          {step === 'approve' ? 'Now confirm the code on your main device…' : step === 'linking' ? 'Setting up this device…' : 'Copying your chats…'}
        </p>
      )}
      {step === 'waiting' && code && !err && (
        <button onClick={() => copy(code, 'Code copied. Paste it on your main device.')} className="mt-4 flex items-center justify-center gap-1.5 text-sm text-muted hover:text-ink">
          <Icon name="copy" className="size-4" /> Can't scan? Copy the code instead
        </button>
      )}
      {err && (
        <>
          <p role="alert" className="mt-4 text-center text-sm text-danger">
            {err}
          </p>
          <Button className="mt-4 w-full" onClick={() => setAttempt((n) => n + 1)}>
            Show a new code
          </Button>
        </>
      )}
      <p className="mt-6 text-center text-sm text-muted">Your chats are copied to this device end-to-end encrypted. The server can't read them.</p>
    </Centered>
  )
}

/** Username field with live availability. Shared by onboarding and settings. */
function useUsername(initial = '') {
  const [name, setName] = useState(initial)
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
  useEffect(() => {
    if (!name || name === initial) return setStatus('idle')
    setStatus('checking')
    const t = setTimeout(() => fog.checkUsername(name).then(setStatus), 350)
    return () => clearTimeout(t)
  }, [name, initial])
  const hint = {
    idle: '3 to 32 characters: lowercase letters, numbers and underscores.',
    checking: 'Checking…',
    available: `@${name} is available`,
    taken: `@${name} is taken`,
    invalid: 'Start with a letter. Use only lowercase letters, numbers and underscores.',
  }[status]
  const field = (
    <>
      <div className="flex items-center rounded-2xl border border-line bg-raised px-4 focus-within:border-lamp">
        <span className="text-lg text-muted">@</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s/g, ''))}
          autoFocus
          maxLength={32}
          spellCheck={false}
          autoCapitalize="none"
          className="h-14 w-full bg-transparent pl-1 text-lg text-ink outline-none"
          aria-describedby="uname-hint"
        />
      </div>
      <p id="uname-hint" className={`mt-1 text-sm ${status === 'available' ? 'text-emerald-600 dark:text-emerald-400' : status === 'taken' || status === 'invalid' ? 'text-danger' : 'text-muted'}`}>
        {hint}
      </p>
    </>
  )
  return { name, status, setStatus, field }
}

function UsernameStep() {
  const u = useUsername()
  const [busy, setBusy] = useState(false)
  return (
    <Centered>
      <h1 className="text-2xl font-bold">Choose a username</h1>
      <p className="mt-2 text-muted">People find you by your username. It's the only thing about you the server knows.</p>
      <form
        className="mt-6"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await fog.claimUsername(u.name)
          } catch {
            u.setStatus('taken')
            setBusy(false)
          }
        }}
      >
        {u.field}
        <Button className="mt-6 w-full" disabled={u.status !== 'available' || busy}>
          {busy ? <Spinner /> : 'Continue'}
        </Button>
      </form>
      <button onClick={fog.skipUsername} className="mt-3 w-full text-sm text-muted hover:text-ink">
        Skip for now. People can still reach you by account ID.
      </button>
    </Centered>
  )
}

// ---------- main layout ----------
const lastTs = (c: Chat) => c.messages.at(-1)?.ts ?? 0
const sortedChats = (chats: Record<string, Chat>) => Object.values(chats).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || lastTs(b) - lastTs(a))

/**
 * Phone back button / gesture (and the browser's Back on a phone): close whatever is on top (a menu,
 * dialog or panel), then the open chat, then leave. Works by keeping one history entry of our own
 * and putting it back after each step.
 */
function useBackButton() {
  useEffect(() => {
    if (!matchMedia('(max-width: 767px)').matches) return
    history.pushState({ fog: 1 }, '')
    const onPop = () => {
      if (document.querySelector('[role=menu],[role=dialog],[data-drawer]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        history.pushState({ fog: 1 }, '')
      } else if (fog.getState().active) {
        fog.openChat(null)
        history.pushState({ fog: 1 }, '')
      }
      // Nothing left to close: don't re-arm, so the next Back leaves the app as usual.
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
}

/**
 * Phones: swipe right on a chat to go back to the chat list, the chat following the finger with the list
 * showing underneath (iOS has no Back gesture of its own in the app; Android's system Back also works,
 * through useBackButton). Starts anywhere in the chat, except in a text box or something that scrolls
 * sideways and isn't at its start, and only for a clearly sideways drag, so vertical scrolling is untouched.
 */
function useSwipeBack(main: React.RefObject<HTMLElement | null>, active: string | null, setPeek: (on: boolean) => void) {
  useEffect(() => {
    const el = main.current
    if (!el || !active || !matchMedia('(max-width: 767px)').matches) return
    // Sideways drags are ours, not the browser's (vertical scrolling stays native, and so does
    // sideways scrolling inside a code block or table, which is its own scroll container).
    el.style.touchAction = 'pan-y'
    let x0 = 0, y0 = 0, dx = 0, vx = 0, last = 0, edge = false
    let on: boolean | null = false // null: deciding, true: swiping
    const blocked = (t: EventTarget | null) => {
      for (let n = t as HTMLElement | null; n && n !== el; n = n.parentElement) {
        if (n.matches('input,textarea,select,[contenteditable=true],.touch-none')) return true
        if (n.scrollWidth > n.clientWidth + 1 && n.scrollLeft > 0 && getComputedStyle(n).overflowX !== 'visible') return true
      }
      return false
    }
    const start = (e: TouchEvent) => {
      const t = e.touches[0]
      const ok = e.touches.length === 1 && !document.querySelector('[role=menu],[role=dialog],[data-drawer]') && !blocked(e.target)
      on = ok ? null : false
      edge = t.clientX < 32
      x0 = t.clientX; y0 = t.clientY; dx = 0; vx = 0; last = e.timeStamp
    }
    const move = (e: TouchEvent) => {
      if (on === false) return
      const t = e.touches[0]
      const x = Math.max(0, t.clientX - x0)
      const dy = Math.abs(t.clientY - y0)
      if (on === null) {
        // From the very edge, claim the touch at once, before iOS can start scrolling the messages.
        if (edge && e.cancelable) e.preventDefault()
        if (x < 10 && dy < 10) return
        on = edge ? x > dy : x > dy * 1.5
        if (!on) return
        setPeek(true)
        el.style.transition = 'none'
      }
      if (e.cancelable) e.preventDefault()
      vx = (x - dx) / Math.max(1, e.timeStamp - last)
      dx = x; last = e.timeStamp
      el.style.transform = `translateX(${dx}px)`
    }
    const end = () => {
      if (!on) return void (on = false)
      on = false
      const back = dx > el.offsetWidth / 3 || (vx > 0.35 && dx > 40)
      el.style.transition = 'transform 180ms ease-out'
      el.style.transform = `translateX(${back ? el.offsetWidth : 0}px)`
      setTimeout(() => {
        el.style.transition = el.style.transform = ''
        if (back) fog.openChat(null)
        setPeek(false)
      }, 180)
    }
    const opts = { capture: true, passive: false }
    el.addEventListener('touchstart', start, { capture: true, passive: true })
    el.addEventListener('touchmove', move, opts)
    el.addEventListener('touchend', end, true)
    el.addEventListener('touchcancel', end, true)
    return () => {
      el.style.touchAction = ''
      el.removeEventListener('touchstart', start, true)
      el.removeEventListener('touchmove', move, true)
      el.removeEventListener('touchend', end, true)
      el.removeEventListener('touchcancel', end, true)
    }
  }, [active])
}

function Main() {
  const active = useFog((s) => s.active)
  const lockPrompted = useFog((s) => s.settings.lockPrompted)
  const [protect, setProtect] = useState<'ask' | 'set' | null>(null)
  useBackButton()
  const mainEl = useRef<HTMLElement>(null)
  const [peek, setPeek] = useState(false)
  useSwipeBack(mainEl, active, setPeek)
  useEffect(() => {
    if (!lockPrompted) db.lockEnabled().then((on) => (on ? fog.updateSettings({ lockPrompted: true }) : setProtect('ask')))
  }, [])
  const [panel, setPanel] = useState<'none' | 'settings' | 'new' | 'group' | 'archived' | 'requests'>('none')
  const aside = useRef<HTMLElement>(null)
  const width = useFog((s) => s.settings.sidebar ?? 360)
  const collapsed = useFog((s) => !!s.settings.sidebarCollapsed)
  const [dragW, setDragW] = useState<number | null>(null)
  // Folded to a rail, except while a panel (settings, new chat...) needs the room. While dragging,
  // the preview is either the rail or a real chat list, never a full list squeezed in between.
  const rail = panel === 'none' && (dragW === null ? collapsed : dragW === RAIL)
  const [info, setInfo] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = fog.getState()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPanel('none')
        search.current?.focus()
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const list = sortedChats(s.chats)
        const i = list.findIndex((c) => c.id === s.active)
        const next = list[i + (e.key === 'ArrowDown' ? 1 : -1)] ?? list[e.key === 'ArrowDown' ? 0 : list.length - 1]
        if (next) fog.openChat(next.id)
      } else if (e.key === 'Escape' && !document.querySelector('[data-drawer],[role=menu],[role=dialog]')) {
        fog.openChat(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => setInfo(false), [active])
  return (
    <div className="relative flex h-full overflow-hidden bg-panel pt-[env(safe-area-inset-top)]">
      <aside
        ref={aside}
        style={{ '--sb': `${rail ? RAIL : (dragW ?? width)}px` } as React.CSSProperties}
        className={`relative flex w-full shrink-0 flex-col overflow-hidden border-line md:w-[var(--sb)] md:border-r ${dragW === null || dragW === RAIL || dragW === SB_MIN ? 'md:transition-[width] md:duration-150' : ''} ${active && !peek ? 'max-md:hidden' : ''}`}
      >
        <Sidebar
          compact={rail}
          searchRef={search}
          onMenu={() => setPanel('settings')}
          onNew={() => setPanel('new')}
          onArchived={() => setPanel('archived')}
          onRequests={() => setPanel('requests')}
          onSearch={() => (fog.updateSettings({ sidebarCollapsed: false }), setTimeout(() => search.current?.focus(), 220))}
        />
        <SidebarHandle aside={aside} width={width} collapsed={collapsed} onDrag={setDragW} />
        {panel === 'settings' && <Settings onClose={() => setPanel('none')} />}
        {panel === 'new' && <NewChat onClose={() => setPanel('none')} onGroup={() => setPanel('group')} />}
        {panel === 'group' && <NewGroup onClose={() => setPanel('none')} />}
        {panel === 'archived' && <Archived onClose={() => setPanel('none')} />}
        {panel === 'requests' && <Archived requests onClose={() => setPanel('none')} />}
      </aside>
      <main
        ref={mainEl}
        className={`min-w-0 flex-1 ${active ? '' : 'max-md:hidden'} ${peek ? 'absolute inset-x-0 top-[env(safe-area-inset-top)] bottom-0 z-10 bg-panel shadow-[-8px_0_24px_rgba(0,0,0,.25)]' : ''}`}
      >
        {active ? <ChatPane key={active} id={active} onInfo={() => setInfo((v) => !v)} /> : <EmptyPane />}
      </main>
      {active && info && <ChatInfo key={active} id={active} onClose={() => setInfo(false)} />}
      {protect === 'ask' && (
        <Dialog
          title="Protect Fog on this device"
          onClose={() => (fog.updateSettings({ lockPrompted: true }), setProtect(null))}
          actions={
            <>
              <Button kind="ghost" onClick={() => (fog.updateSettings({ lockPrompted: true }), setProtect(null))}>
                Not now
              </Button>
              <Button onClick={() => (fog.updateSettings({ lockPrompted: true }), setProtect('set'))}>Set a passcode</Button>
            </>
          }
        >
          Your keys and messages are stored on this device. With a passcode{fog.isDesktop ? '' : ' (or Touch ID / Face ID)'}, they're encrypted so nobody with access to this device can read them.{' '}You can change this later in Settings.
        </Dialog>
      )}
      {protect === 'set' && <AppLockDialog onClose={() => setProtect(null)} />}
    </div>
  )
}

function EmptyPane() {
  return (
    <div className="fogbank grid h-full place-items-center">
      <span className="rounded-full bg-black/25 px-4 py-1.5 text-sm font-medium text-white backdrop-blur-md dark:bg-white/10">Select a chat to start messaging</span>
    </div>
  )
}

function Sidebar({
  onMenu,
  onNew,
  onArchived,
  onRequests,
  onSearch,
  searchRef,
  compact,
}: {
  onMenu: () => void
  onNew: () => void
  onArchived: () => void
  onRequests: () => void
  onSearch: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
  compact?: boolean
}) {
  const chats = useFog((s) => s.chats)
  const people = useFog((s) => s.people)
  const active = useFog((s) => s.active)
  const conn = useFog((s) => s.conn)
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const list = sortedChats(chats).filter((c) => !c.request && (q ? chatTitle(c, people[c.id]).toLowerCase().includes(q) || people[c.id]?.username?.includes(q) : !c.archived))
  const archived = Object.values(chats).filter((c) => c.archived && !c.request)
  const requests = Object.values(chats).filter((c) => c.request)
  const [hits, more] = useMemo(() => {
    if (q.length < 2) return [[], 0]
    const terms = fog.searchTerms(q)
    const out: { chat: Chat; m: Msg }[] = []
    for (const c of Object.values(chats)) for (const m of c.messages) if (fog.msgMatches(m, terms)) out.push({ chat: c, m })
    out.sort((a, b) => b.m.ts - a.m.ts)
    return [out.slice(0, 100), Math.max(0, out.length - 100)]
  }, [chats, q])

  // Folded: an avatar rail (unread badges stay visible), like Telegram's narrow sidebar.
  if (compact) {
    const all = sortedChats(chats).filter((c) => !c.request && !c.archived)
    return (
      <>
        <header className="flex h-16 shrink-0 items-center justify-center">
          <IconButton icon="menu" label="Settings" onClick={onMenu} />
        </header>
        <nav className="scroll-thin flex flex-1 flex-col gap-1 overflow-y-auto pb-24" aria-label="Chats">
          <button onClick={onSearch} title="Search" aria-label="Search chats and messages" className="mx-auto grid size-12 shrink-0 place-items-center rounded-full bg-raised text-muted transition hover:text-ink">
            {conn === 'online' ? <Icon name="search" className="size-5" /> : <Spinner className="size-4" />}
          </button>
          {requests.length > 0 && (
            <button onClick={onRequests} title="Message requests" aria-label={`Message requests, ${requests.length}`} className="relative mx-auto grid size-[64px] place-items-center rounded-2xl hover:bg-hover">
              <span className="grid size-[50px] place-items-center rounded-full bg-lamp/20 text-lamp">
                <Icon name="inbox" />
              </span>
              <span className="absolute top-1 right-1 grid h-5 min-w-5 place-items-center rounded-full bg-lamp px-1.5 text-xs font-bold text-lamp-ink ring-2 ring-panel">{requests.length}</span>
            </button>
          )}
          {archived.length > 0 && (
            <button onClick={onArchived} title="Archived chats" aria-label="Archived chats" className="relative mx-auto grid size-[64px] place-items-center rounded-2xl hover:bg-hover">
              <span className="grid size-[50px] place-items-center rounded-full bg-raised text-muted">
                <Icon name="archive" />
              </span>
            </button>
          )}
          {all.map((c) => (
            <ChatRow key={c.id} chat={c} active={c.id === active} compact />
          ))}
        </nav>
        <button
          onClick={onNew}
          aria-label="New chat"
          title="New chat"
          className="absolute bottom-[max(1.25rem,var(--safe-bottom))] left-1/2 grid size-12 -translate-x-1/2 place-items-center rounded-full bg-lamp text-lamp-ink shadow-lg shadow-black/25 transition hover:scale-105 active:scale-95"
        >
          <Icon name="pencil" className="size-5" />
        </button>
      </>
    )
  }

  return (
    <>
      {/* min-w: as the list widens out of the rail, it's revealed at its real size, not squeezed. */}
      <header className="flex h-16 shrink-0 items-center gap-2 px-3 md:min-w-[280px]">
        <IconButton icon="menu" label="Settings" onClick={onMenu} />
        <div className="flex h-10 flex-1 items-center gap-2 rounded-full bg-raised px-3 text-muted focus-within:ring-2 focus-within:ring-lamp/50">
          {conn === 'online' ? <Icon name="search" className="size-5 shrink-0" /> : <Spinner className="size-4 shrink-0" />}
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setFilter(''), e.currentTarget.blur())}
            placeholder={conn === 'online' ? 'Search' : 'Connecting…'}
            aria-label="Search chats and messages"
            className="w-full bg-transparent text-base text-ink outline-none placeholder:text-muted md:text-[15px]"
          />
          {filter && <IconButton icon="close" label="Clear search" onClick={() => setFilter('')} className="-mr-2 size-8" />}
        </div>
      </header>
      <nav
        className="scroll-thin flex-1 overflow-y-auto px-2 pb-24 md:min-w-[280px]"
        aria-label="Chats"
        onKeyDown={(e) => {
          // Arrow keys move between chats, like a list.
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(':scope > button')]
          const i = rows.indexOf(document.activeElement as HTMLElement)
          if (i < 0) return
          e.preventDefault()
          rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
        }}
      >
        {q && list.length > 0 && <p className="px-3 pt-2 pb-1 text-sm font-semibold text-muted">Chats</p>}
        {!q && requests.length > 0 && (
          <button onClick={onRequests} className="flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition hover:bg-hover">
            <span className="grid size-[54px] shrink-0 place-items-center rounded-full bg-lamp/20 text-lamp">
              <Icon name="inbox" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Message requests</span>
              <span className="block truncate text-[15px] text-muted">{requests.map((c) => chatTitle(c, people[c.id])).join(', ')}</span>
            </span>
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-lamp px-1.5 text-xs font-bold text-lamp-ink">{requests.length}</span>
          </button>
        )}
        {!q && archived.length > 0 && (
          <button onClick={onArchived} className="flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition hover:bg-hover">
            <span className="grid size-[54px] shrink-0 place-items-center rounded-full bg-raised text-muted">
              <Icon name="archive" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Archived chats</span>
              <span className="block truncate text-[15px] text-muted">{archived.map((c) => chatTitle(c, people[c.id])).join(', ')}</span>
            </span>
            {archived.some((c) => c.unread) && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-muted/40 px-1.5 text-xs font-bold text-ink">{archived.reduce((n, c) => n + c.unread, 0)}</span>}
          </button>
        )}
        {list.map((c) => (
          <ChatRow key={c.id} chat={c} active={c.id === active} />
        ))}
        {hits.length > 0 && (
          <>
            <p className="px-3 pt-4 pb-1 text-sm font-semibold text-muted">Messages</p>
            {hits.map(({ chat, m }) => (
              <button
                key={m.id}
                onClick={() => {
                  fog.openChat(chat.id)
                  setTimeout(() => fog.jumpTo(m.id), 50)
                }}
                className="flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition hover:bg-hover"
              >
                <Avatar id={chat.id} name={chatTitle(chat, people[chat.id])} src={chatAvatar(chat, people[chat.id])} size={46} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{chatTitle(chat, people[chat.id])}</span>
                    {!chat.group && people[chat.id]?.bot && <BotBadge />}
                    <span className="ml-auto shrink-0 text-xs text-muted">{fmtListTime(m.ts)}</span>
                  </div>
                  <p className="truncate text-[15px] text-muted">
                    {m.mine ? 'You: ' : chat.group ? `${personName(m.from ?? '', people[m.from ?? ''])}: ` : ''}
                    <Highlight text={m.text || m.poll?.q || m.link?.title || m.att?.name || ''} q={q} />
                  </p>
                </div>
              </button>
            ))}
          </>
        )}
        {more > 0 && <p className="px-3 pt-2 pb-4 text-center text-sm text-muted">{more} older {more === 1 ? 'match' : 'matches'}. Add another word to narrow it down.</p>}
        {q && !list.length && !hits.length && <p className="px-6 pt-12 text-center text-muted">No chats or messages match “{filter}”.</p>}
        {!q && !list.length && !archived.length && !requests.length && (
          <div className="px-6 pt-16 text-center">
            <div className="mx-auto grid size-20 place-items-center rounded-full bg-raised text-muted">
              <Icon name="pencil" className="size-8" />
            </div>
            <p className="mt-4 font-semibold">No chats yet</p>
            <p className="mt-1 text-sm text-muted">Start a chat with someone's username or account ID.</p>
            <Button className="mt-5" onClick={onNew}>
              Start a chat
            </Button>
          </div>
        )}
      </nav>
      <button
        onClick={onNew}
        aria-label="New chat"
        title="New chat"
        className="absolute right-5 bottom-[max(1.25rem,var(--safe-bottom))] grid size-14 place-items-center rounded-full bg-lamp text-lamp-ink shadow-lg shadow-black/25 transition hover:scale-105 active:scale-95"
      >
        <Icon name="pencil" />
      </button>
    </>
  )
}

/** The text around the first search word, with that word marked (accents ignored, as in the search). */
function Highlight({ text, q }: { text: string; q: string }) {
  // Fold character by character so positions line up with the original text.
  const folded = [...text].map((c) => fog.fold(c)[0] ?? c).join('')
  const word = fog.searchTerms(q).find((t) => folded.includes(t))
  const i = word ? folded.indexOf(word) : -1
  if (!word || i < 0) return <>{text}</>
  const chars = [...text]
  const start = Math.max(0, i - 24)
  return (
    <>
      {start > 0 && '…'}
      {chars.slice(start, i).join('')}
      <mark className="rounded bg-lamp/35 px-0.5 text-ink">{chars.slice(i, i + word.length).join('')}</mark>
      {chars.slice(i + word.length).join('')}
    </>
  )
}

const RAIL = 84
const SB_MIN = 280
const SB_MAX = 520
/** Narrower than this while dragging folds the list into the avatar rail. */
const SB_FOLD = 200

/**
 * The chat list's right edge: drag to resize, drag far left (or double-click) to fold it into an
 * avatar rail. Keyboard: arrows resize, Enter folds and unfolds.
 */
function SidebarHandle({ aside, width, collapsed, onDrag }: { aside: React.RefObject<HTMLElement | null>; width: number; collapsed: boolean; onDrag: (w: number | null) => void }) {
  const commit = (w: number) => (w < SB_FOLD ? fog.updateSettings({ sidebarCollapsed: true }) : fog.updateSettings({ sidebarCollapsed: false, sidebar: Math.round(Math.min(SB_MAX, Math.max(SB_MIN, w))) }))
  const toggle = () => fog.updateSettings({ sidebarCollapsed: !collapsed })
  // Double-click is detected here: preventDefault on pointerdown (no text selection while dragging)
  // also stops the browser's dblclick.
  const lastTap = useRef(0)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Chat list width. Drag or use arrow keys to resize; Enter to collapse or expand."
      aria-valuenow={collapsed ? RAIL : width}
      aria-valuemin={RAIL}
      aria-valuemax={SB_MAX}
      tabIndex={0}
      title="Drag to resize. Double-click to collapse."
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        if (e.timeStamp - lastTap.current < 350) return (lastTap.current = 0), toggle()
        lastTap.current = e.timeStamp
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const left = aside.current!.getBoundingClientRect().left
        let w = collapsed ? RAIL : width
        const move = (ev: PointerEvent) => {
          w = ev.clientX - left
          // Below the fold point, preview the rail; otherwise the clamped width.
          onDrag(w < SB_FOLD ? RAIL : Math.min(SB_MAX, Math.max(SB_MIN, w)))
        }
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
          onDrag(null)
          if (w !== (collapsed ? RAIL : width)) commit(w)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), toggle())
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const step = e.key === 'ArrowLeft' ? -24 : 24
          if (collapsed) e.key === 'ArrowRight' && fog.updateSettings({ sidebarCollapsed: false })
          else commit(width + step < SB_MIN ? SB_FOLD - 1 : width + step)
        }
      }}
      className="group absolute inset-y-0 right-0 z-30 hidden w-1.5 cursor-col-resize outline-none md:block"
    >
      <span className="absolute inset-y-0 right-0 w-0.5 bg-lamp opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  )
}

function ChatRow({ chat, active, compact }: { chat: Chat; active: boolean; compact?: boolean }) {
  const person = useFog((s) => s.people[chat.id])
  const people = useFog((s) => s.people)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [del, setDel] = useState(false)
  const press = usePressMenu((at) => setMenu(at))
  const last = chat.messages.at(-1)
  const typing = chat.typing && chat.typing.until > Date.now() ? chat.typing : null
  const title = chatTitle(chat, person)
  const unread = chat.unread > 0 || !!chat.markedUnread
  const muted = isMuted(chat)
  const [muteDialog, setMuteDialog] = useState(false)
  const who = last && !last.sys && chat.group ? (last.mine ? 'You' : personName(last.from ?? '', people[last.from ?? ''])) : null
  if (compact)
    return (
      <button
        onClick={() => fog.openChat(chat.id)}
        title={title}
        aria-label={`${title}${unread ? `, ${chat.unread || ''} unread` : ''}`}
        className={`relative mx-auto grid size-[64px] place-items-center rounded-2xl transition ${active ? 'bg-lamp/20 dark:bg-lamp/[0.13]' : 'hover:bg-hover'}`}
      >
        <Avatar id={chat.id} name={title} src={chatAvatar(chat, person)} size={50} />
        {(unread || !!chat.mentions) && (
          <span className={`pop absolute top-1 right-1 grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-xs font-bold ring-2 ring-panel ${muted ? 'bg-muted/60 text-ink' : 'bg-lamp text-lamp-ink'}`}>
            {chat.mentions ? '@' : chat.unread || ''}
          </span>
        )}
      </button>
    )
  return (
    <>
      <button
        onClick={() => fog.openChat(chat.id)}
        {...press}
        className={`flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition select-none ${active ? 'bg-lamp/20 dark:bg-lamp/[0.13]' : 'hover:bg-hover'} ${menu ? 'bg-hover' : ''}`}
      >
        <Avatar id={chat.id} name={title} src={chatAvatar(chat, person)} size={54} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {chat.group && <Icon name="users" className="size-4 shrink-0 self-center text-muted" />}
            <span className="truncate font-semibold">{title}</span>
            {person?.bot && <span className="self-center"><BotBadge /></span>}
            {muted && <Icon name="bellOff" className="size-4 shrink-0 self-center text-muted" />}
            {chat.timer && <Icon name="timer" className="size-4 shrink-0 self-center text-muted" />}
            <span className={`ml-auto flex shrink-0 items-center gap-1 text-xs ${unread && !muted ? 'text-lamp' : 'text-muted'}`}>
              {last?.mine && !chat.draft && <Ticks status={msgStatus(chat, last)} />}
              {last && fmtListTime(last.ts)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className={`truncate text-[15px] ${typing ? 'text-lamp' : 'text-muted'}`}>
              {typing ? (
                chat.group ? `${personName(typing.by, people[typing.by])} is typing…` : 'typing…'
              ) : chat.draft && !active ? (
                <>
                  <span className="text-danger">Draft: </span>
                  {chat.draft}
                </>
              ) : last ? (
                <>
                  {who && <span className="text-ink/80">{who}: </span>}
                  {snippet(last)}
                </>
              ) : (
                'No messages yet'
              )}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {chat.pinned && !unread && <Icon name="pin" className="size-4 text-muted" />}
              {!!chat.mentions && <span className="pop grid size-5 place-items-center rounded-full bg-lamp text-xs font-bold text-lamp-ink">@</span>}
              {unread && (
                <span className={`pop grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-xs font-bold ${muted ? 'bg-muted/40 text-ink' : 'bg-lamp text-lamp-ink'}`}>{chat.unread || ''}</span>
              )}
            </span>
          </div>
        </div>
      </button>
      {menu && (
        <Menu at={menu} onClose={() => setMenu(null)}>
          {!chat.archived && <MenuItem icon={chat.pinned ? 'unpin' : 'pin'} label={chat.pinned ? 'Unpin' : 'Pin to top'} onClick={() => (fog.pinChat(chat.id, !chat.pinned), setMenu(null))} />}
          <MenuItem icon={unread ? 'check' : 'unread'} label={unread ? 'Mark as read' : 'Mark as unread'} onClick={() => (fog.markUnread(chat.id, !unread), setMenu(null))} />
          {chat.id !== SAVED && <MenuItem icon={muted ? 'bell' : 'bellOff'} label={muted ? 'Unmute' : 'Mute'} onClick={() => (muted ? fog.muteChat(chat.id, 0) : setMuteDialog(true), setMenu(null))} />}
          <MenuItem icon="archive" label={chat.archived ? 'Unarchive' : 'Archive'} onClick={() => (fog.archiveChat(chat.id, !chat.archived), setMenu(null), fog.toast(chat.archived ? 'Chat unarchived' : 'Chat archived'))} />
          <MenuItem icon="trash" label={chat.group && !chat.group.left ? 'Leave and delete' : 'Delete chat'} danger onClick={() => (setDel(true), setMenu(null))} />
        </Menu>
      )}
      {del && <DeleteChatDialog chat={chat} onClose={() => setDel(false)} />}
      {muteDialog && <MuteDialog id={chat.id} onClose={() => setMuteDialog(false)} />}
    </>
  )
}

function Archived({ onClose, requests }: { onClose: () => void; requests?: boolean }) {
  const chats = useFog((s) => s.chats)
  const active = useFog((s) => s.active)
  const list = sortedChats(chats).filter((c) => (requests ? c.request : c.archived && !c.request))
  useEffect(() => {
    if (!list.length) onClose()
  }, [list.length])
  return (
    <Drawer title={requests ? 'Message requests' : 'Archived chats'} onClose={onClose}>
      <p className="px-3 pb-2 text-sm text-muted">
        {requests
          ? "People you haven't chatted with yet. They can't see that you've read their messages, and their calls don't ring, until you accept."
          : 'Archived chats stay here until a new message arrives. Muted chats stay archived.'}
      </p>
      {list.map((c) => (
        <ChatRow key={c.id} chat={c} active={c.id === active} />
      ))}
    </Drawer>
  )
}

function Choice<T>({ title, options, value, onPick, onClose, note }: { title: string; options: [T, string][]; value?: T; onPick: (v: T) => void; onClose: () => void; note?: string }) {
  return (
    <Dialog title={title} onClose={onClose} actions={<Button kind="ghost" onClick={onClose}>Cancel</Button>}>
      {note && <p className="mb-2">{note}</p>}
      <div className="-mx-2" role="radiogroup">
        {options.map(([v, label]) => (
          <button
            key={String(v)}
            role="radio"
            aria-checked={v === value}
            onClick={() => (onPick(v), onClose())}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-ink transition hover:bg-hover"
          >
            <span className={`grid size-5 place-items-center rounded-full border-2 ${v === value ? 'border-lamp' : 'border-muted/50'}`}>{v === value && <span className="size-2.5 rounded-full bg-lamp" />}</span>
            {label}
          </button>
        ))}
      </div>
    </Dialog>
  )
}

function MuteDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const h = 3600_000
  return (
    <Choice
      title="Mute notifications"
      options={[
        [h, 'For 1 hour'],
        [8 * h, 'For 8 hours'],
        [168 * h, 'For 1 week'],
        [-1, 'Until I turn it back on'],
      ]}
      onPick={(d) => (fog.muteChat(id, d < 0 ? 8.64e15 : Date.now() + d), fog.toast('Notifications muted'))}
      onClose={onClose}
      note="Mentions of you still notify."
    />
  )
}

function TimerDialog({ id, value, onClose }: { id: string; value: number; onClose: () => void }) {
  return (
    <Choice
      title="Disappearing messages"
      note="New messages vanish for everyone in this chat after they've been read. Existing messages aren't affected."
      options={TIMERS.map((t) => [t, timerLabel(t)] as [number, string])}
      value={value}
      onPick={(t) => t !== value && fog.setTimer(id, t)}
      onClose={onClose}
    />
  )
}

function DeleteChatDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const group = chat.group && !chat.group.left
  return (
    <Dialog
      title={group ? 'Leave group?' : 'Delete chat?'}
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="danger" onClick={() => (fog.deleteChat(chat.id), onClose(), fog.toast(group ? 'You left the group' : 'Chat deleted'))}>
            {group ? 'Leave and delete' : 'Delete chat'}
          </Button>
        </>
      }
    >
      {group ? `You'll stop receiving messages from “${chatTitle(chat)}”, and the chat is deleted from this device.` : `This deletes your conversation with ${chatTitle(chat)} from this device. They keep their copy.`}
    </Dialog>
  )
}

// ---------- settings ----------
function Settings({ onClose }: { onClose: () => void }) {
  const me = useFog((s) => s.me)!
  const profile = useFog((s) => s.profile)
  const settings = useFog((s) => s.settings)
  const [name, setName] = useState(profile.name)
  const [showPhrase, setShowPhrase] = useState(false)
  const [notif, setNotif] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission)
  const [dialog, setDialog] = useState<'none' | 'logout' | 'username' | 'share' | 'blocked' | 'lock' | 'devices' | 'delete'>('none')
  const devices = useFog((s) => s.devices)
  const [lockOn, setLockOn] = useState(false)
  useEffect(() => void db.lockEnabled().then(setLockOn), [dialog])
  const blocked = useFog((s) => s.blocked)
  const backup = useFog((s) => s.backup)
  const [startOver, setStartOver] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const saveName = () => name.trim() !== profile.name && fog.setProfile({ name: name.trim() })
  const display = profile.name || (me.username ? `@${me.username}` : 'You')
  return (
    <Drawer title="Settings" onClose={onClose}>
      <div className="flex flex-col items-center pt-2 pb-4 text-center">
        <button onClick={() => file.current?.click()} className="group relative rounded-full" aria-label="Change profile photo">
          <Avatar id={me.id} name={display} src={profile.avatar} size={104} />
          <span className="absolute inset-0 grid place-items-center rounded-full bg-black/40 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
            <Icon name="camera" className="size-8" />
          </span>
          <span className="absolute right-0 bottom-0 grid size-8 place-items-center rounded-full bg-lamp text-lamp-ink ring-4 ring-panel">
            <Icon name="camera" className="size-4" />
          </span>
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) fog.setProfile({ avatar: await avatarFrom(f) })
          }}
        />
        {profile.avatar && (
          <button onClick={() => fog.setProfile({ avatar: undefined })} className="mt-2 text-sm text-muted hover:text-danger">
            Remove photo
          </button>
        )}
      </div>
      <button onClick={() => (fog.openSaved(), onClose())} className="mb-3 flex w-full items-center gap-3 rounded-2xl bg-raised p-2.5 text-left transition hover:bg-hover">
        <Avatar id={SAVED} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Saved Messages</span>
          <span className="block text-sm text-muted">Notes and files for yourself</span>
        </span>
        <Icon name="next" className="size-5 text-muted" />
      </button>
      <div className="rounded-2xl bg-raised p-1">
        <label className="flex items-center gap-4 rounded-xl px-3 py-2">
          <Icon name="user" className="size-6 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 64))}
              onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              placeholder="Add your name"
              className="w-full bg-transparent text-base text-ink outline-none placeholder:text-muted"
            />
            <p className="text-sm text-muted">Name</p>
          </div>
        </label>
        <Row icon="at" title={me.username ? `@${me.username}` : 'Set a username'} sub="Username" onClick={() => setDialog('username')} />
        <Row icon="key" title={<span className="font-mono text-sm">{shortId(me.id)}</span>} sub="Account ID. Tap to copy." onClick={() => copy(me.id, 'Account ID copied')} />
        <Row icon="qr" title="QR code and invite link" sub="Let people add you in one tap" onClick={() => setDialog('share')} />
      </div>
      <p className="mt-2 px-3 text-sm text-muted">Your name and photo are end-to-end encrypted and only shared with people you message.</p>

      <Section title="Appearance">
        <div className="px-3 py-2">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-raised p-1" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={settings.theme === t}
                onClick={() => fog.updateSettings({ theme: t })}
                className={`h-9 rounded-lg text-sm font-medium capitalize transition ${settings.theme === t ? 'bg-panel shadow-sm dark:bg-hover' : 'text-muted hover:text-ink'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <label className="mt-4 flex items-center gap-3">
            <span className="text-sm text-muted">A</span>
            <input
              type="range"
              min={14}
              max={20}
              value={settings.textSize}
              onChange={(e) => fog.updateSettings({ textSize: Number(e.target.value) })}
              className="flex-1 accent-[var(--lamp)]"
              aria-label="Message text size"
            />
            <span className="text-lg text-muted">A</span>
          </label>
          <div className="fogbank mt-3 flex flex-col gap-1.5 rounded-2xl px-5 py-3">
            <span className="text-msg tail-in relative self-start rounded-[18px] rounded-bl-[4px] bg-in px-3 py-1.5">Is this text size comfortable?</span>
            <span className="text-msg tail-out relative self-end rounded-[18px] rounded-br-[4px] bg-out px-3 py-1.5 text-out-ink">Just right 👌</span>
          </div>
        </div>
      </Section>

      <Section title="Notifications">
        {fog.isDesktop ? (
          <Row
            icon="bell"
            title="Notifications"
            sub="Pop up when a message arrives and Fog isn't in front"
            right={<Toggle label="Notifications" on={settings.notifications !== false} onChange={(v) => fog.updateSettings({ notifications: v })} />}
          />
        ) : (
          <Row
            icon="bell"
            title="Desktop notifications"
            sub={notif === 'granted' ? 'On while Fog is in the background' : notif === 'denied' ? 'Blocked in your browser settings' : 'Off'}
            onClick={notif === 'default' ? () => Notification.requestPermission().then(setNotif) : undefined}
            right={notif === 'default' ? <span className="text-sm font-semibold text-lamp">Turn on</span> : undefined}
          />
        )}
        <Row
          icon="eye"
          title="Message previews"
          sub="Show who it's from and what they said. Off: just “New message”."
          right={<Toggle label="Message previews" on={settings.previews !== false} onChange={(v) => fog.updateSettings({ previews: v })} />}
        />
        <Row icon="volume" title="Sounds" sub="Play a sound for new messages" right={<Toggle label="Sounds" on={settings.sounds} onChange={(v) => fog.updateSettings({ sounds: v })} />} />
      </Section>

      <Section title="Privacy">
        <Row icon="check" title="Read receipts" sub="Let people see when you've read their messages" right={<Toggle label="Read receipts" on={settings.readReceipts} onChange={(v) => fog.updateSettings({ readReceipts: v })} />} />
        <Row icon="pencil" title="Typing indicators" sub="Show when you're typing" right={<Toggle label="Typing indicators" on={settings.typing} onChange={(v) => fog.updateSettings({ typing: v })} />} />
        <Row icon="lockOn" title="App lock" sub={lockOn ? 'On: passcode required to open Fog' : 'Off'} onClick={() => setDialog('lock')} />
        <Row icon="block" title="Blocked accounts" sub={blocked.length ? `${blocked.length} blocked` : 'None'} onClick={() => setDialog('blocked')} />
        <Row
          icon="link"
          title="Link previews"
          sub="When you type a link, your Fog server fetches its preview. Recipients get it inside the encrypted message."
          right={<Toggle label="Link previews" on={settings.linkPreviews} onChange={(v) => fog.updateSettings({ linkPreviews: v })} />}
        />
        <Row
          icon="phone"
          title="Relay all calls"
          sub="Route calls through your Fog server so the other person never sees your IP address. Calls may be slightly slower."
          right={<Toggle label="Relay all calls" on={settings.relayCalls} onChange={(v) => fog.updateSettings({ relayCalls: v })} />}
        />
      </Section>

      <Section title="Devices">
        <Row
          icon="laptop"
          title="Devices"
          sub={me.main ? (devices.length > 1 ? `${devices.length} devices` : 'Use Fog on your computer too') : 'This device is linked to your main device'}
          onClick={() => setDialog('devices')}
        />
      </Section>

      <Section title="Chat backup">
        {me.main ? (
          <>
            <Row
              icon="archive"
              title="Back up chats"
              sub={
                settings.backup === false
                  ? 'Off. Losing this device means losing your chats.'
                  : backup.busy
                    ? 'Backing up…'
                    : backup.at
                      ? `Last backup ${new Date(backup.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
                      : 'Daily, encrypted with your recovery phrase'
              }
              right={<Toggle label="Back up chats" on={settings.backup !== false} onChange={(v) => fog.updateSettings({ backup: v })} />}
            />
            {backup.restoreFailed && (
              <div className="mx-1 my-2 rounded-2xl bg-danger/10 p-3 text-sm">
                <p className="font-semibold">Your chat backup couldn't be restored</p>
                <p className="mt-1 text-muted">Fog keeps your old backup and won't make a new one until it's restored, so those chats aren't lost. Check your connection and try again.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button className="h-9 px-3 text-sm" onClick={() => void fog.retryRestore()}>
                    Try again
                  </Button>
                  <Button kind="ghost" className="h-9 px-3 text-sm" onClick={() => setStartOver(true)}>
                    Start over without them
                  </Button>
                </div>
              </div>
            )}
            {startOver && (
              <Dialog
                title="Start over without your old chats?"
                onClose={() => setStartOver(false)}
                actions={
                  <>
                    <Button kind="ghost" onClick={() => setStartOver(false)}>
                      Cancel
                    </Button>
                    <Button kind="danger" onClick={() => (setStartOver(false), void fog.skipRestore())}>
                      Replace the backup
                    </Button>
                  </>
                }
              >
                <p className="text-[15px] text-muted">Your next backup replaces the old one on the server, and the chats in it can't be brought back after that.</p>
              </Dialog>
            )}
            {settings.backup !== false && !backup.restoreFailed && <Row icon="upload" title="Back up now" onClick={() => void fog.backupNow(true)} />}
            <p className="px-3 pt-1 text-sm text-muted">
              Your messages, contacts and groups, encrypted on this device with a key from your recovery phrase. The server keeps only the latest copy and can't read it. Restore your account with the phrase on a new phone and your chats come back. Photos and files come back for as long as the server keeps them (45 days).
            </p>
          </>
        ) : (
          <p className="px-3 text-sm text-muted">Backups are made by your main device, the one with your recovery phrase.</p>
        )}
      </Section>

      {me.main ? (
      <Section title="Recovery phrase">
        <p className="px-3 text-sm text-muted">The only way back into your account on a new device. Never share it.</p>
        <div className="relative mx-3 mt-3">
          <p className={`rounded-2xl bg-raised p-4 text-[15px] leading-relaxed ${showPhrase ? '' : 'fogged'}`}>{fog.phrase()}</p>
          {!showPhrase && (
            <button onClick={() => setShowPhrase(true)} className="absolute inset-0 grid place-items-center font-semibold">
              <span className="flex items-center gap-2 rounded-full bg-panel px-4 py-2 shadow">
                <Icon name="eye" className="size-5" /> Show phrase
              </span>
            </button>
          )}
        </div>
      </Section>
      ) : (
        <Section title="Recovery phrase">
          <p className="px-3 text-sm text-muted">Your recovery phrase is on your main device. Linked devices never receive it.</p>
        </Section>
      )}

      <Section title="Help">
        <Row icon="info" title="Fog guide" sub="Tips and answers, in a chat on this device" onClick={() => (onClose(), fog.openGuide())} />
        <Row icon="info" title="Privacy policy" onClick={() => fog.openExternal('https://getfog.org/privacy/')} />
        <Row icon="info" title="Terms of use" onClick={() => fog.openExternal('https://getfog.org/terms/')} />
      </Section>

      <div className="mt-6">
        <Row icon="out" title={<span className="text-danger">Log out</span>} onClick={() => setDialog('logout')} />
        {me.main && <Row icon="out" title={<span className="text-danger">Delete account</span>} onClick={() => setDialog('delete')} />}
      </div>

      {dialog === 'delete' && (
        <Dialog
          title="Delete your Fog account?"
          onClose={() => setDialog('none')}
          actions={
            <>
              <Button kind="ghost" onClick={() => setDialog('none')}>
                Cancel
              </Button>
              <Button kind="danger" onClick={() => fog.deleteAccount().catch(() => fog.toast("Couldn't delete your account. Check your connection."))}>
                Delete account
              </Button>
            </>
          }
        >
          This permanently removes your account and current chat backup, frees your username, revokes linked devices and clears this device. Recipients can keep their copies.
        </Dialog>
      )}

      {dialog === 'logout' && (
        <Dialog
          title="Log out of Fog?"
          onClose={() => setDialog('none')}
          actions={
            <>
              <Button kind="ghost" onClick={() => setDialog('none')}>
                Cancel
              </Button>
              <Button kind="danger" onClick={fog.logout}>
                Log out
              </Button>
            </>
          }
        >
          {me.main
            ? 'This erases your keys and messages from this device. You need your recovery phrase to log back in.'
            : 'This unlinks this device from your account and erases its keys and messages. Your other devices keep working.'}
        </Dialog>
      )}
      {dialog === 'devices' && <DevicesDialog onClose={() => setDialog('none')} />}
      {dialog === 'username' && <UsernameDialog current={me.username ?? ''} onClose={() => setDialog('none')} />}
      {dialog === 'share' && <ShareDialog onClose={() => setDialog('none')} />}
      {dialog === 'lock' && <AppLockDialog onClose={() => setDialog('none')} />}
      {dialog === 'blocked' && (
        <Dialog title="Blocked accounts" onClose={() => setDialog('none')} actions={<Button onClick={() => setDialog('none')}>Done</Button>}>
          {blocked.length ? (
            <div className="-mx-2 mt-1">
              {blocked.map((id) => (
                <PersonRow key={id} id={id} right={<Button kind="soft" className="h-9 px-3 text-sm" onClick={() => fog.unblock(id)}>Unblock</Button>} />
              ))}
            </div>
          ) : (
            "You haven't blocked anyone. Blocked people can't message or call you, and they aren't told."
          )}
        </Dialog>
      )}
    </Drawer>
  )
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 2 ? 'Active now' : m < 60 ? `Active ${m} minutes ago` : m < 1440 ? `Active ${Math.round(m / 60)} hours ago` : `Active ${Math.round(m / 1440)} days ago`
}
const deviceLabel = (d: fog.DeviceInfo) => d.name || (d.id === 1 ? 'Main device' : `Device ${d.id}`)

function DevicesDialog({ onClose }: { onClose: () => void }) {
  const me = useFog((s) => s.me)!
  const devices = useFog((s) => s.devices)
  const [linking, setLinking] = useState(false)
  const [unlink, setUnlink] = useState<fog.DeviceInfo | null>(null)
  useEffect(() => void fog.loadDevices(), [])
  if (linking) return <LinkDeviceDialog onClose={() => setLinking(false)} />
  if (unlink)
    return (
      <Dialog
        title={unlink.id === me.device ? 'Unlink this device?' : `Unlink ${deviceLabel(unlink)}?`}
        onClose={() => setUnlink(null)}
        actions={
          <>
            <Button kind="ghost" onClick={() => setUnlink(null)}>
              Cancel
            </Button>
            <Button kind="danger" onClick={() => fog.unlinkDevice(unlink.id).then(() => setUnlink(null), () => fog.toast("Couldn't unlink. Check your connection."))}>
              Unlink
            </Button>
          </>
        }
      >
        {unlink.id === me.device ? 'This device is signed out and everything Fog stored on it is erased.' : "It's signed out right away and can't get back in without being linked again."}
      </Dialog>
    )
  const canAdd = me.main && devices.length < 5
  return (
    <Dialog
      title="Devices"
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Done
          </Button>
          {canAdd && <Button onClick={() => setLinking(true)}>Link a device</Button>}
        </>
      }
    >
      <div className="-mx-2 mt-2">
        {devices.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-raised text-ink">
              <Icon name="laptop" className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink">
                {deviceLabel(d)}
                {d.id === 1 && <span className="ml-2 rounded-full bg-lamp/20 px-2 py-0.5 text-xs font-semibold text-out-accent">Main</span>}
              </p>
              <p className="text-sm">{d.id === me.device ? 'This device' : !d.ready ? 'Setting up…' : ago(d.seen)}</p>
            </div>
            {d.id !== 1 && (me.main || d.id === me.device) && (
              <Button kind="soft" className="h-9 px-3 text-sm" onClick={() => setUnlink(d)}>
                Unlink
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-sm">
        {me.main
          ? 'Link a browser or the desktop app. Each device gets your chat history and its own encryption keys, and works even when this one is offline.'
          : 'Only your main device, the one with your recovery phrase, can link or unlink other devices.'}
      </p>
    </Dialog>
  )
}

const linkError = (e: string) =>
  ({
    too_many_devices: "You've linked as many devices as you can (5). Unlink one first.",
    gone: 'That code expired. Show a new one on the other device.',
    timeout: "The other device didn't finish setting up. Check it's online and try again.",
    main_only: 'Only your main device can link devices.',
    bad_code: "That isn't a Fog link code.",
    old_code: 'Update Fog on the new device, then show a new code.',
    cancelled: 'Linking cancelled. Nothing was sent.',
  })[e] ?? "Couldn't link that device. Check your connection and try again."

/** Main device: scan (or paste) the new device's code, send it the account and chat history. */
function LinkDeviceDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<'scan' | 'confirm' | 'hello' | 'check' | 'sending' | 'waiting' | 'done'>('scan')
  const [err, setErr] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [typing, setTyping] = useState(false)
  const [pending, setPending] = useState('')
  const [check, setCheck] = useState<{ code: string; answer: (ok: boolean) => void } | null>(null)
  // Closing the dialog mid-check counts as "doesn't match", so nothing is sent.
  useEffect(() => () => check?.answer(false), [check])
  const scanned = async (code: string): Promise<string | null> => {
    setErr(null)
    if (!fog.parseLinkCode(code)) return (setErr(linkError('bad_code')), linkError('bad_code'))
    setPending(code)
    setStep('confirm')
    return null
  }
  const run = async (code: string) => {
    setStep('hello')
    try {
      await fog.linkDevice(code, setStep, (c) => new Promise<boolean>((answer) => (setCheck({ code: c, answer }), setStep('check'))))
      setStep('done')
      return null
    } catch (e) {
      const m = linkError((e as Error).message)
      setStep('scan')
      setErr(m)
      return m
    }
  }
  const busy = step === 'hello' || step === 'sending' || step === 'waiting'
  if (step === 'check' && check)
    return (
      <Dialog
        title="Check the code"
        onClose={() => check.answer(false)}
        actions={
          <>
            <Button kind="ghost" onClick={() => check.answer(false)}>
              It doesn't match
            </Button>
            <Button onClick={() => check.answer(true)}>It matches</Button>
          </>
        }
      >
        <p>The new device should be showing this code. Only continue if it's on a device in front of you. Nothing has been sent yet.</p>
        <p className="mt-4 text-center font-mono text-3xl font-semibold tracking-wider text-ink tabular-nums">{check.code}</p>
      </Dialog>
    )
  if (step === 'confirm')
    return (
      <Dialog
        title="Link this device?"
        onClose={onClose}
        actions={
          <>
            <Button kind="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void run(pending)}>Link device</Button>
          </>
        }
      >
        It will be able to read all your messages, including your chat history, and send messages as you. Only link a device you own and can see right now. If someone sent you this code, don't continue.
      </Dialog>
    )
  return (
    <Dialog
      title={step === 'done' ? 'Device linked' : 'Link a device'}
      onClose={busy ? () => {} : onClose}
      actions={
        step === 'done' ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        )
      }
    >
      {step === 'scan' && (
        <>
          <p>On the new device, choose “Link to an existing account” and scan the code it shows.</p>
          {/* Typing the code instead: the camera makes way for the keyboard (and stays away while
              there's a code in the box, so the Link button doesn't jump as the keyboard closes). */}
          {canScan && !typing && !paste && <QrScanner onCode={scanned} />}
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void scanned(paste)
            }}
          >
            <input
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
              placeholder={canScan ? 'Or paste the code' : 'Paste the code from the new device'}
              aria-label="Link code"
              className="min-w-0 flex-1 rounded-xl border border-line bg-raised px-3 py-2 text-base text-ink outline-none focus:border-lamp"
            />
            <Button disabled={!paste.trim()} className="h-10 px-4">
              Link
            </Button>
          </form>
          {err && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {err}
            </p>
          )}
        </>
      )}
      {busy && (
        <div className="flex flex-col items-center py-8 text-center">
          <Spinner />
          <p role="status" className="mt-4 font-medium text-ink">
            {step === 'hello' ? 'Connecting to the new device…' : step === 'sending' ? 'Sending your chats, end-to-end encrypted…' : 'Finishing up on the new device…'}
          </p>
        </div>
      )}
      {step === 'done' && <p>Your new device is ready. Messages now arrive on all your devices.</p>}
    </Dialog>
  )
}

function UsernameDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const u = useUsername(current)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await fog.claimUsername(u.name)
      fog.toast(`You're now @${u.name}`)
      onClose()
    } catch {
      u.setStatus('taken')
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Username"
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={u.status !== 'available' || busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="mt-2">{u.field}</div>
    </Dialog>
  )
}

// ---------- new chat / group ----------
/** Look someone up by @username or account id as you type. */
function usePeerSearch(q: string) {
  const [res, setRes] = useState<{ id: string; username: string | null } | 'none' | 'loading' | null>(null)
  useEffect(() => {
    if (q.trim().replace(/^@/, '').length < 3) return setRes(null)
    setRes('loading')
    const t = setTimeout(() => fog.findPeer(q).then(setRes, () => setRes('none')), 350)
    return () => clearTimeout(t)
  }, [q])
  return res
}

function PersonRow({ id, sub, onClick, right }: { id: string; sub?: string; onClick?: () => void; right?: ReactNode }) {
  const p = useFog((s) => s.people[id])
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} className={`fade-in flex w-full items-center gap-3 rounded-2xl p-2.5 text-left ${onClick ? 'transition hover:bg-hover' : ''}`}>
      <Avatar id={id} name={personName(id, p)} src={p?.avatar} size={46} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{personName(id, p)}</p>
        <p className="truncate text-sm text-muted">{sub ?? (p?.name && p.username ? `@${p.username}` : shortId(id))}</p>
      </div>
      {right}
    </Tag>
  )
}

function NewChat({ onClose, onGroup }: { onClose: () => void; onGroup: () => void }) {
  const me = useFog((s) => s.me)!
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<'none' | 'scan' | 'share'>('none')
  const res = usePeerSearch(q)
  return (
    <Drawer title="New chat" onClose={onClose}>
      {(close) => {
        const found = typeof res === 'object' && res ? res : null
        return (
          <>
            <form onSubmit={(e) => (e.preventDefault(), found && found.id !== me.id && (fog.startChat(found.id), close()))}>
              <div className="flex h-12 items-center gap-2 rounded-xl border border-line bg-raised px-3 focus-within:border-lamp">
                <Icon name="search" className="size-5 text-muted" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="none"
                  placeholder="Username or account ID"
                  className="w-full bg-transparent text-base text-ink outline-none placeholder:text-muted"
                />
              </div>
            </form>
            <div className="mt-3">
              {res === 'loading' && (
                <p className="flex items-center gap-2 px-3 text-sm text-muted">
                  <Spinner /> Searching
                </p>
              )}
              {res === 'none' && <p className="px-3 text-sm text-muted">Nobody found with that username or account ID.</p>}
              {found && (found.id === me.id ? <p className="px-3 text-sm text-muted">That's your own account.</p> : <PersonRow id={found.id} onClick={() => (fog.startChat(found.id), close())} />)}
            </div>
            {res === null && (
              <>
                {(
                  [
                    ['users', 'New group', onGroup],
                    ...(canScan ? [['qr', 'Scan a QR code', () => setDialog('scan')]] : []),
                    ['link', 'Share my invite link', () => setDialog('share')],
                  ] as [string, string, () => void][]
                ).map(([icon, label, fn]) => (
                  <button key={label} onClick={fn} className="mt-1 flex w-full items-center gap-4 rounded-2xl p-2.5 text-left transition hover:bg-hover">
                    <span className="grid size-[46px] place-items-center rounded-full bg-lamp/20 text-lamp">
                      <Icon name={icon} />
                    </span>
                    <span className="font-semibold">{label}</span>
                  </button>
                ))}
                <div className="mt-4 rounded-2xl bg-raised p-4">
                  <p className="font-semibold">Invite someone</p>
                  <p className="mt-1 text-sm text-muted">Share your {me.username ? 'username' : 'account ID'} so people can start a chat with you.</p>
                  <button
                    onClick={() => copy(me.username ? `@${me.username}` : me.id, me.username ? 'Username copied' : 'Account ID copied')}
                    className="mt-3 flex w-full items-center gap-2 rounded-xl bg-panel px-3 py-2.5 text-left transition hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{me.username ? `@${me.username}` : me.id}</span>
                    <Icon name="copy" className="size-5 text-muted" />
                  </button>
                </div>
              </>
            )}
            {dialog === 'scan' && (
              <ScanDialog
                onClose={() => setDialog('none')}
                onCode={async (raw) => {
                  const id = /#add=([A-Za-z0-9_-]{43})/.exec(raw)?.[1]
                  if (!id) return "That isn't a Fog invite code."
                  try {
                    await fog.findPeer(id)
                    fog.startChat(id)
                    close()
                    return null
                  } catch {
                    return "That code doesn't match any Fog account."
                  }
                }}
              />
            )}
            {dialog === 'share' && <ShareDialog onClose={() => setDialog('none')} />}
          </>
        )
      }}
    </Drawer>
  )
}

// Any device with a camera. (Browsers without a built-in QR reader, like iPhones, load a decoder.)
const canScan = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

/** Your account as a QR code + invite link. The link only contains your public account id. */
function ShareDialog({ onClose }: { onClose: () => void }) {
  const me = useFog((s) => s.me)!
  const profile = useFog((s) => s.profile)
  const link = fog.inviteLink()
  const qr = useMemo(() => `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { ecc: 'H', border: 2, blackColor: '#15202b', whiteColor: '#ffffff' }))}`, [link])
  return (
    <Dialog
      title="Add me on Fog"
      onClose={onClose}
      actions={
        <>
          {navigator.share && (
            <Button kind="ghost" onClick={() => navigator.share({ title: 'Add me on Fog', url: link }).catch(() => {})}>
              Share
            </Button>
          )}
          <Button onClick={() => copy(link, 'Invite link copied')}>Copy link</Button>
        </>
      }
    >
      <div className="mt-2 flex flex-col items-center">
        <div className="relative rounded-3xl bg-white p-3 shadow-inner">
          <img src={qr} alt="QR code for your invite link" className="size-56" />
          <img src="/icon.svg" alt="" className="absolute top-1/2 left-1/2 size-12 -translate-x-1/2 -translate-y-1/2 rounded-xl ring-4 ring-white" />
        </div>
        <p className="mt-3 font-semibold text-ink">{profile.name || (me.username ? `@${me.username}` : shortId(me.id))}</p>
        {me.username && profile.name && <p className="text-sm">@{me.username}</p>}
        <p className="mt-2 text-center text-sm">Scanning this opens a chat with you. It only contains your public account ID.</p>
      </div>
    </Dialog>
  )
}

/** Camera QR scanner. `onCode` returns an error to show, or null when the code was handled. */
function ScanDialog({ onClose, onCode, title = 'Scan a QR code', hint = 'Point your camera at a Fog QR code.' }: { onClose: () => void; onCode: (raw: string) => Promise<string | null>; title?: string; hint?: string }) {
  return (
    <Dialog title={title} onClose={onClose} actions={<Button kind="ghost" onClick={onClose}>Cancel</Button>}>
      <QrScanner onCode={onCode} hint={hint} />
    </Dialog>
  )
}

/** Live camera QR scanner. `onCode` returns an error to show (and keeps scanning), or null when done. */
function QrScanner({ onCode, hint = 'Point your camera at the code.' }: { onCode: (raw: string) => Promise<string | null>; hint?: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let stream: MediaStream | undefined
    let stop = false
    ;(async () => {
      try {
        const detect = await qrReader()
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stop) return stream.getTracks().forEach((t) => t.stop())
        video.current!.srcObject = stream
        await video.current!.play()
        let last = ''
        while (!stop) {
          const raw = await detect(video.current!).catch(() => null)
          if (raw && raw !== last) {
            last = raw
            const e = await onCode(raw)
            if (!e) break
            setErr(e)
          }
          await new Promise((r) => setTimeout(r, 250))
        }
      } catch {
        setErr('Fog needs camera access to scan a code.')
      }
    })()
    return () => {
      stop = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])
  return (
    <>
      <div className="relative mt-3 aspect-square overflow-hidden rounded-3xl bg-black">
        <video ref={video} playsInline muted className="size-full object-cover" />
        <div className="pointer-events-none absolute inset-10 rounded-3xl border-4 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
      </div>
      <p className={`mt-3 text-center text-sm ${err ? 'text-danger' : ''}`}>{err ?? hint}</p>
    </>
  )
}

/**
 * Read a QR code from the camera. Chrome and Android have a built-in reader; iPhones, Safari and
 * Firefox don't, so they get jsQR, loaded only then.
 */
async function qrReader(): Promise<(v: HTMLVideoElement) => Promise<string | null>> {
  if ('BarcodeDetector' in window) {
    const d = new (window as any).BarcodeDetector({ formats: ['qr_code'] })
    return async (v) => (await d.detect(v))[0]?.rawValue ?? null
  }
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return async (v) => {
    if (!v.videoWidth) return null
    // A smaller frame decodes faster and is plenty for a code filling the frame.
    const scale = Math.min(1, 640 / v.videoWidth)
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data || null
  }
}

/** Pick people: your existing contacts plus anyone found by username or account id. */
function PeoplePicker({ picked, setPicked, exclude = [] }: { picked: string[]; setPicked: (f: (p: string[]) => string[]) => void; exclude?: string[] }) {
  const chats = useFog((s) => s.chats)
  const people = useFog((s) => s.people)
  const me = useFog((s) => s.me)!
  const [q, setQ] = useState('')
  const res = usePeerSearch(q)
  const contacts = Object.values(chats)
    .filter((c) => !c.group && !exclude.includes(c.id))
    .map((c) => c.id)
    .filter((id) => !q || personName(id, people[id]).toLowerCase().includes(q.toLowerCase().replace(/^@/, '')))
  const found = typeof res === 'object' && res && res.id !== me.id && !exclude.includes(res.id) && !contacts.includes(res.id) ? res.id : null
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const check = (id: string) => (
    <span className={`grid size-6 place-items-center rounded-full border-2 transition ${picked.includes(id) ? 'border-lamp bg-lamp text-lamp-ink' : 'border-muted/50'}`}>{picked.includes(id) && <Icon name="check" className="size-4" />}</span>
  )
  return (
    <>
      {picked.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {picked.map((id) => (
            <button key={id} onClick={() => toggle(id)} className="pop flex items-center gap-1.5 rounded-full bg-lamp/20 py-1 pr-2.5 pl-1 text-sm font-medium" aria-label={`Remove ${personName(id, people[id])}`}>
              <Avatar id={id} name={personName(id, people[id])} src={people[id]?.avatar} size={22} />
              {personName(id, people[id])}
              <Icon name="close" className="size-3.5 text-muted" />
            </button>
          ))}
        </div>
      )}
      <div className="flex h-12 items-center gap-2 rounded-xl border border-line bg-raised px-3 focus-within:border-lamp">
        <Icon name="search" className="size-5 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus spellCheck={false} autoCapitalize="none" placeholder="Search contacts or a username" className="w-full bg-transparent text-base text-ink outline-none placeholder:text-muted" />
      </div>
      <div className="mt-2">
        {found && <PersonRow id={found} onClick={() => (toggle(found), setQ(''))} right={check(found)} />}
        {contacts.map((id) => (
          <PersonRow key={id} id={id} onClick={() => toggle(id)} right={check(id)} />
        ))}
        {!contacts.length && !found && <p className="px-3 py-4 text-sm text-muted">{res === 'loading' ? 'Searching…' : 'Type a username or paste an account ID to add someone.'}</p>}
      </div>
    </>
  )
}

function NewGroup({ onClose }: { onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([])
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<string>()
  const file = useRef<HTMLInputElement>(null)
  return (
    <Drawer
      title={step === 1 ? 'Add members' : 'New group'}
      onClose={onClose}
      actions={
        step === 1 && (
          <Button className="h-9 px-4 text-sm" disabled={!picked.length} onClick={() => setStep(2)}>
            Next
          </Button>
        )
      }
    >
      {(close) =>
        step === 1 ? (
          <PeoplePicker picked={picked} setPicked={setPicked} />
        ) : (
          <div className="fade-in">
            <div className="flex items-center gap-4 py-2">
              <button onClick={() => file.current?.click()} aria-label="Group photo" className="relative grid size-20 shrink-0 place-items-center overflow-hidden rounded-full bg-lamp/20 text-lamp">
                {avatar ? <img src={avatar} alt="" className="size-full object-cover" /> : <Icon name="camera" className="size-8" />}
              </button>
              <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => e.target.files?.[0] && setAvatar(await avatarFrom(e.target.files[0]))} />
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 64))}
                autoFocus
                placeholder="Group name"
                onKeyDown={(e) => e.key === 'Enter' && name.trim() && (fog.createGroup(name.trim(), picked, avatar), close())}
                className="h-12 min-w-0 flex-1 border-b-2 border-line bg-transparent text-lg text-ink outline-none focus:border-lamp"
              />
            </div>
            <p className="mt-4 px-1 text-sm font-semibold text-lamp">{picked.length + 1} members</p>
            {picked.map((id) => (
              <PersonRow key={id} id={id} />
            ))}
            <Button className="mt-6 w-full" disabled={!name.trim()} onClick={() => (fog.createGroup(name.trim(), picked, avatar), close())}>
              Create group
            </Button>
            <p className="mt-3 text-center text-xs text-muted">Every message is end-to-end encrypted to each member separately.</p>
          </div>
        )
      }
    </Drawer>
  )
}

// ---------- chat info ----------
function ChatInfo({ id, onClose }: { id: string; onClose: () => void }) {
  const chat = useFog((s) => s.chats[id])
  const person = useFog((s) => s.people[id])
  const me = useFog((s) => s.me)!
  const [dialog, setDialog] = useState<'none' | 'delete' | 'add' | 'leave' | 'mute' | 'timer' | 'block' | 'report' | 'scan'>('none')
  useFog((s) => s.blocked)
  const [menu, setMenu] = useState<{ at: MenuAt; id: string } | null>(null)
  const [name, setName] = useState(chat?.name ?? '')
  const file = useRef<HTMLInputElement>(null)
  if (!chat) return null
  const g = chat.group
  const owner = g?.owner === me.id && !g.left
  const title = chatTitle(chat, person)
  const media = chat.messages.filter((m) => m.att && (m.att.kind === 'photo' || m.att.kind === 'video')).reverse()
  const docs = chat.messages.filter((m) => m.att && (m.att.kind === 'file' || m.att.kind === 'audio')).reverse()
  const saved = fog.isLocalChat(id)
  const sn = g || saved ? [] : (fog.safetyNumber(id).match(/.{5}/g) ?? [])
  return (
    <Drawer title={g ? 'Group info' : 'Info'} onClose={onClose} side="right">
      <div className="flex flex-col items-center pt-2 pb-6 text-center">
        <button onClick={() => owner && file.current?.click()} className={`group relative rounded-full ${owner ? '' : 'cursor-default'}`} aria-label={owner ? 'Change group photo' : undefined} tabIndex={owner ? 0 : -1}>
          <Avatar id={id} name={title} src={chatAvatar(chat, person)} size={104} />
          {owner && (
            <span className="absolute inset-0 grid place-items-center rounded-full bg-black/40 text-white opacity-0 transition group-hover:opacity-100">
              <Icon name="camera" className="size-8" />
            </span>
          )}
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => e.target.files?.[0] && fog.updateGroup(id, { avatar: await avatarFrom(e.target.files[0]) })} />
        {owner ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 64))}
            onBlur={() => name.trim() && name.trim() !== chat.name && fog.updateGroup(id, { name: name.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            aria-label="Group name"
            className="mt-3 w-full rounded-lg bg-transparent text-center text-xl font-semibold outline-none hover:bg-hover focus:bg-raised"
          />
        ) : (
          <p className="mt-3 flex items-center gap-1.5 text-xl font-semibold">
            {title}
            {person?.verified && <Icon name="shield" className="size-5 text-emerald-500" />}
          </p>
        )}
        <p className="text-muted">{g ? `${g.members.length} members` : person?.name && person.username ? `@${person.username}` : ''}</p>
      </div>

      {!saved && (!g || !g.left) && (
        <div className="mb-3 rounded-2xl bg-raised p-1">
          <Row
            icon={isMuted(chat) ? 'bellOff' : 'bell'}
            title="Notifications"
            sub={isMuted(chat) ? (chat.muted! > 8e15 ? 'Muted' : `Muted until ${new Date(chat.muted!).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`) : 'On'}
            right={<Toggle label="Notifications" on={!isMuted(chat)} onChange={(on) => (on ? fog.muteChat(id, 0) : setDialog('mute'))} />}
          />
          <Row icon="timer" title="Disappearing messages" sub={timerLabel(chat.timer)} onClick={() => setDialog('timer')} />
        </div>
      )}
      {!g && !saved && (
        <div className="rounded-2xl bg-raised p-1">
          {person?.username && <Row icon="at" title={`@${person.username}`} sub="Username. Tap to copy." onClick={() => copy(`@${person.username}`, 'Username copied')} />}
          <Row icon="key" title={<span className="font-mono text-sm">{shortId(id)}</span>} sub="Account ID. Tap to copy." onClick={() => copy(id, 'Account ID copied')} />
        </div>
      )}

      {g && (
        <Section title={`${g.members.length} members`}>
          {owner && (
            <button onClick={() => setDialog('add')} className="flex w-full items-center gap-3 rounded-2xl p-2.5 text-left text-lamp transition hover:bg-hover">
              <span className="grid size-[46px] place-items-center rounded-full bg-lamp/15">
                <Icon name="plus" />
              </span>
              <span className="font-semibold">Add members</span>
            </button>
          )}
          {g.members.map((m) =>
            m === me.id ? (
              <PersonRow key={m} id={m} sub={g.owner === m ? 'Owner' : 'Member'} />
            ) : (
              <PersonRow
                key={m}
                id={m}
                sub={g.owner === m ? 'Owner' : undefined}
                onClick={() => (fog.startChat(m), onClose())}
                right={
                  owner && (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Member options"
                      onClick={(e) => (e.stopPropagation(), setMenu({ at: { x: e.clientX, y: e.clientY }, id: m }))}
                      className="grid size-9 place-items-center rounded-full text-muted hover:bg-hover"
                    >
                      <Icon name="menu" className="size-5" />
                    </span>
                  )
                }
              />
            ),
          )}
        </Section>
      )}

      {media.length > 0 && (
        <Section title="Photos and videos">
          <div className="grid grid-cols-3 gap-1 overflow-hidden rounded-2xl">
            {media.slice(0, 15).map((m) => (
              <Thumb key={m.id} m={m} />
            ))}
          </div>
        </Section>
      )}
      {docs.length > 0 && (
        <Section title="Files">
          {docs.slice(0, 20).map((m) => (
            <button key={m.id} onClick={() => fog.jumpTo(m.id)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-hover">
              <span className="grid size-10 place-items-center rounded-lg bg-slate-500 text-white">
                <Icon name="file" className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.att!.name}</span>
                <span className="text-xs text-muted">{fmtListTime(m.ts)}</span>
              </span>
            </button>
          ))}
        </Section>
      )}

      {!g && !saved && (
        <Section title="Safety number">
          <p className="px-3 text-sm text-muted">
            {person?.verified
              ? "You've verified that this is really them. Their keys can't change without this chat becoming a different account."
              : 'Scan their code, or compare the numbers in person or on a call. A match proves nobody is impersonating them.'}
          </p>
          <div className="mx-3 mt-3 flex items-center gap-4 rounded-2xl bg-raised p-4">
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(fog.safetyQr(id), { border: 1, blackColor: '#15202b', whiteColor: '#ffffff' }))}`} alt="Your safety code for this chat" className="size-28 shrink-0 rounded-lg bg-white p-1" />
            <div className="grid flex-1 grid-cols-3 gap-x-2 gap-y-1 font-mono text-sm tabular-nums">
              {sn.map((s, i) => (
                <span key={i}>{s}</span>
              ))}
            </div>
          </div>
          {canScan && <Row icon="qr" title="Scan their code" onClick={() => setDialog('scan')} />}
          <Row
            icon="shield"
            title={person?.verified ? 'Clear verification' : 'Mark as verified'}
            sub={person?.verified ? 'Verified' : 'Only after comparing the numbers'}
            onClick={() => fog.setVerified(id, !person?.verified)}
          />
        </Section>
      )}

      <div className="mt-6">
        <Row icon={chat.pinned ? 'unpin' : 'pin'} title={chat.pinned ? 'Unpin chat' : 'Pin chat'} onClick={() => fog.pinChat(id, !chat.pinned)} />
        {g && !g.left && <Row icon="out" title={<span className="text-danger">Leave group</span>} onClick={() => setDialog('leave')} />}
        {!g && !saved && (
          <>
            <Row icon="block" title={<span className="text-danger">{fog.isBlocked(id) ? 'Unblock' : 'Block'}</span>} onClick={() => (fog.isBlocked(id) ? fog.unblock(id) : setDialog('block'))} />
            <Row icon="flag" title={<span className="text-danger">Report and block</span>} onClick={() => setDialog('report')} />
          </>
        )}
        <Row icon="trash" title={<span className="text-danger">Delete chat</span>} onClick={() => setDialog('delete')} />
      </div>

      {menu && (
        <Menu at={menu.at} onClose={() => setMenu(null)}>
          <MenuItem icon="send" label="Message" onClick={() => (fog.startChat(menu.id), setMenu(null), onClose())} />
          <MenuItem icon="trash" label="Remove from group" danger onClick={() => (fog.updateGroup(id, { remove: [menu.id] }), setMenu(null))} />
        </Menu>
      )}
      {dialog === 'delete' && <DeleteChatDialog chat={chat} onClose={() => setDialog('none')} />}
      {dialog === 'mute' && <MuteDialog id={id} onClose={() => setDialog('none')} />}
      {dialog === 'scan' && (
        <ScanDialog
          title="Scan their safety code"
          hint="Ask them to open this chat's info and show you their code."
          onClose={() => setDialog('none')}
          onCode={async (raw) => {
            if (fog.verifySafetyCode(id, raw)) {
              fog.toast(`${title} is verified`)
              setDialog('none')
              return null
            }
            return "Codes don't match. You may not be talking to who you think, or they scanned a different chat."
          }}
        />
      )}
      {(dialog === 'block' || dialog === 'report') && (
        <Dialog
          title={dialog === 'block' ? `Block ${title}?` : `Report ${title}?`}
          onClose={() => setDialog('none')}
          actions={
            <>
              <Button kind="ghost" onClick={() => setDialog('none')}>
                Cancel
              </Button>
              <Button kind="danger" onClick={() => (dialog === 'block' ? fog.block(id) : fog.report(id), setDialog('none'))}>
                {dialog === 'block' ? 'Block' : 'Report and block'}
              </Button>
            </>
          }
        >
          {dialog === 'block'
            ? "They won't be able to message or call you, and they won't be told you blocked them."
            : 'Fog is told this account is sending spam or abuse. Your messages stay end-to-end encrypted, so nothing you wrote is shared. They are also blocked.'}
        </Dialog>
      )}
      {dialog === 'timer' && <TimerDialog id={id} value={chat.timer ?? 0} onClose={() => setDialog('none')} />}
      {dialog === 'leave' && (
        <Dialog
          title="Leave group?"
          onClose={() => setDialog('none')}
          actions={
            <>
              <Button kind="ghost" onClick={() => setDialog('none')}>
                Cancel
              </Button>
              <Button kind="danger" onClick={() => (fog.leaveGroup(id), setDialog('none'))}>
                Leave
              </Button>
            </>
          }
        >
          You'll stop receiving messages from “{title}”. The chat history stays on this device.
        </Dialog>
      )}
      {dialog === 'add' && g && <AddMembers id={id} exclude={g.members} onClose={() => setDialog('none')} />}
    </Drawer>
  )
}

function AddMembers({ id, exclude, onClose }: { id: string; exclude: string[]; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([])
  return (
    <Dialog
      title="Add members"
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!picked.length} onClick={() => (fog.updateGroup(id, { add: picked }), onClose())}>
            Add{picked.length > 1 ? ` ${picked.length}` : ''}
          </Button>
        </>
      }
    >
      <div className="scroll-thin mt-2 max-h-[55vh] overflow-y-auto text-ink">
        <PeoplePicker picked={picked} setPicked={setPicked} exclude={exclude} />
      </div>
    </Dialog>
  )
}

function Thumb({ m }: { m: Msg }) {
  const a = m.att!
  const url = useLocalUrl(a.lid)
  useEffect(() => {
    if (a.kind === 'photo' && !url) download(a)
  }, [a.lid])
  return (
    <button onClick={() => fog.jumpTo(m.id)} className="relative aspect-square overflow-hidden bg-black/10" aria-label="Show in chat">
      {a.thumb && <img src={a.thumb} alt="" className="absolute inset-0 size-full object-cover" />}
      {url && a.kind === 'photo' && <img src={url} alt="" className="fade-in absolute inset-0 size-full object-cover" />}
      {a.kind === 'video' && (
        <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[11px] font-medium text-white">▶</span>
      )}
    </button>
  )
}
