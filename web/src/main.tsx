import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { boot } from './fog'
import './guide'

// Safari on iPhone/iPad: the keyboard covers the page instead of shrinking it, and WebKit scrolls the
// whole page up to keep the text box visible, pushing the chat header off screen. Instead, size the
// app to the part above the keyboard and keep the page itself still. (The phone apps resize natively.)
const vv = window.visualViewport
const native = '__TAURI_INTERNALS__' in window
if (vv && !native && navigator.maxTouchPoints > 1 && /iPhone|iPad|Macintosh/.test(navigator.userAgent)) {
  const root = document.documentElement
  const fit = () => {
    root.style.setProperty('--app-h', `${vv.height}px`)
    // Keyboard up: the home indicator is hidden behind it, so drop the bottom safe-area padding.
    root.toggleAttribute('data-keyboard', innerHeight - vv.height > 120)
    if (scrollY) scrollTo(0, 0)
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
  fit()
}

// The iPhone app: the chat moves with the keyboard, like a native messenger.
// - It starts when iOS starts the keyboard's own slide (reported by the native plugin) and uses the
//   keyboard's duration and curve, so the two move as one instead of the chat popping up first.
// - The slide is pure movement (a GPU transform of the message list and composer), and the layout
//   changes just once, at the end when opening and at the start when closing. Animating the height
//   instead would re-lay out every message on every frame.
if (native && navigator.maxTouchPoints > 1 && /iPhone|iPad|Macintosh/.test(navigator.userAgent)) {
  const root = document.documentElement
  // The keyboard covers the home-indicator padding, so it only shrinks the app by its height minus
  // that padding (keeping the composer's usual small gap; see #root in index.css).
  // Measured when the keyboard moves: at startup iOS may not have told the page its safe area yet.
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-bottom:max(0px, calc(env(safe-area-inset-bottom) - 0.6rem))'
  document.body.append(probe)
  const lift = (h: number) => Math.max(0, h - (parseFloat(getComputedStyle(probe).paddingBottom) || 0))
  let laidOut = 0 // keyboard height the layout currently makes room for
  let target = 0
  let moving: Animation[] = []
  const layout = (h: number) => {
    laidOut = h
    root.style.setProperty('--keyboard', `${h}px`)
  }
  ;(window as unknown as { __fogKeyboard: (h: number, s: number) => void }).__fogKeyboard = (h, seconds) => {
    // Never trust a "keyboard" taller than most of the screen (iOS reports some system sheets so).
    if (h > innerHeight * 0.7) return
    // iOS often reports the keyboard twice as it opens (with and without the suggestion row).
    if (h === target) return
    target = h
    const parts = [...document.querySelectorAll<HTMLElement>('[data-slide]')]
    // Where the chat is right now (mid-slide, if one is running), so a new report continues from
    // there instead of snapping back and starting over.
    const now = parts.length ? new DOMMatrixReadOnly(getComputedStyle(parts[0]).transform).m42 : 0
    moving.forEach((a) => a.cancel())
    moving = []
    const shift = lift(h) - lift(laidOut) // how much higher the new layout puts the chat
    if ((!shift && !now) || !parts.length || !seconds) {
      root.toggleAttribute('data-sliding', false)
      return layout(h)
    }
    // iOS draws the text cursor itself and it can't keep up with the slide: hide it until it's over.
    root.toggleAttribute('data-sliding', true)
    const settle = () => {
      moving.forEach((a) => a.cancel())
      moving = []
      root.toggleAttribute('data-sliding', false)
    }
    // UIKit's keyboard curve; the small head start covers the hop from iOS to the page.
    const timing: KeyframeAnimationOptions = { duration: seconds * 1000, delay: -16, easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)', fill: 'forwards' }
    const run = (from: number, to: number) => parts.map((el) => el.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }], timing))
    if (shift > 0) {
      // Opening: slide up in the current layout, then switch to the new one in the same frame.
      moving = run(now, -shift)
      moving[0].onfinish = () => (layout(h), settle())
    } else {
      // Closing: switch to the new layout now, starting where things are, and slide into place.
      layout(h)
      moving = run(now + shift, 0)
      moving[0].onfinish = settle
    }
  }
}

/** If drawing the app ever fails, show a way out instead of a blank window. (Nothing is sent anywhere.) */
class Crashed extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid h-full place-items-center bg-panel p-6 text-center text-ink">
        <div className="max-w-sm">
          <p className="text-lg font-semibold">Something went wrong</p>
          <p className="mt-2 text-sm text-muted">Fog hit an unexpected problem. Your messages and keys are safe on this device.</p>
          <button onClick={() => location.reload()} className="mt-5 rounded-full bg-lamp px-5 py-2.5 font-semibold text-lamp-ink">
            Reload Fog
          </button>
          <p className="mt-4 font-mono text-xs break-words text-muted/70">{String(this.state.error.message).slice(0, 200)}</p>
        </div>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <Crashed>
    <App />
  </Crashed>,
)
boot()
