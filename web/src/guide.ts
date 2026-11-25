// The Fog guide: a first chat for new accounts that shows how chatting works and answers the usual
// questions. It's a script that runs on this device. It isn't a person, an AI or a server account,
// and nothing typed to it leaves the device.
import * as fog from './fog'
import { GUIDE } from './fog'

const TOPICS = ['How is Fog private?', 'How do I add people?', 'What if I lose my phone?', 'Show me some tricks'] as const

const ANSWERS: Record<string, string[]> = {
  private: [
    "Everything you send is *end-to-end encrypted* with the Signal protocol, the same one Signal uses. Only you and the people you talk to can read it, and Fog's server can't.",
    "There's no phone number or email: your account is a key that lives on your devices. Once you've accepted someone, your messages to them are _sealed_, so the server doesn't even learn who sent them.",
    'You can check a contact really is who they say: open their info and compare the safety number.',
  ],
  people: [
    'Tap the *pencil* button and search for someone by their username, or paste their account ID.',
    'You can also share your invite link or QR code from the same screen. It opens a chat with you straight away.',
    "When a stranger writes first, it lands in Message requests. Nothing is sent back, not even read receipts, until you accept.",
  ],
  lost: [
    'Your *24-word recovery phrase* is the only way back into your account. Write it down somewhere safe: Settings → Recovery phrase.',
    "Chat backups are on: once a day your chats are encrypted with a key from that phrase and stored on the server, which can't read them. Restore the phrase on a new phone and your chats come back.",
    'You can also link a computer or a second phone: Settings → Devices. They keep working if this one is gone.',
  ],
  tricks: [
    'Some things to try right here:\n• *bold*, _italic_, ~strikethrough~ and `code`\n• swipe a message (or long-press it) to reply\n• long-press for reactions, edit, pin and more\n• the 😊 button has stickers and your own saved GIFs',
    'Hold the microphone for a voice message, or switch it to the camera for a round video message. Polls, files up to 2 GB and disappearing messages live behind the 📎 button.',
    "Go on, reply to this message or react to it. I'll notice.",
  ],
  devices: ['Settings → Devices → *Link a device*, then scan the QR code on the new device. Your chat history comes along, end-to-end encrypted.'],
  calls: ['Open a chat with someone and use the phone or camera button at the top. Calls are encrypted end to end too, and you can share your screen from a computer.'],
  stickers: ['Tap 😊, then the sticker or *GIF* tab. Add your own, or long-press one someone sends you to save it. Your GIFs stay private: no GIF service is involved.'],
  hello: ["Hi! 👋 Ask me about privacy, adding people, backups, devices, calls or stickers, or just try things out here."],
  thanks: ['Anytime. When you are ready, start a real chat with the pencil button. You can find me again in Settings.'],
  unknown: ["I'm only a simple guide, not a person, so I understand a few topics: privacy, contacts, backups, devices, calls and stickers. Or tap an option in the poll above."],
}

const TOPIC_KEYS = ['private', 'people', 'lost', 'tricks']
function topicOf(text: string) {
  const t = fog.fold(text)
  if (/\b(hi|hey|hello|yo|hola|sup)\b/.test(t)) return 'hello'
  if (/thank|thx|ty\b|cheers|awesome|great|cool/.test(t)) return 'thanks'
  if (/priva|encrypt|secur|safe|signal|server|read my|spy|track/.test(t)) return 'private'
  if (/add|friend|contact|invite|username|find|people|someone/.test(t)) return 'people'
  if (/lose|lost|phrase|backup|restore|recover|new phone|stolen/.test(t)) return 'lost'
  if (/trick|format|bold|reply|react|feature|how do i|what can/.test(t)) return 'tricks'
  if (/device|link|computer|desktop|laptop|tablet/.test(t)) return 'devices'
  if (/call|video|voice|screen/.test(t)) return 'calls'
  if (/sticker|gif|emoji/.test(t)) return 'stickers'
  return 'unknown'
}

let busy = Promise.resolve()
/** Say lines one after another, each after a short "typing…". */
function say(lines: string[]) {
  busy = busy.then(async () => {
    for (const line of lines) await fog.guideSay(line, {}, Math.min(1800, 500 + line.length * 12))
  })
  return busy
}

fog.setGuide({
  start() {
    void say([
      "Hi, I'm the Fog guide. 👋 I live only on this device: nothing you type here is sent anywhere.",
      "This is what a chat looks like in Fog. Ask me anything, or pick what you'd like to know:",
    ]).then(() => fog.guideSay('', { poll: { q: 'What would you like to know?', o: [...TOPICS] } }, 400))
  },
  hear(m) {
    // Reacting shows off reactions; a reply gets the topic it asks about.
    if (/thank|❤️|love/i.test(m.text)) fog.guideReact(m.id, '❤️')
    else if (m.reply) fog.guideReact(m.id, '👍')
    void say(ANSWERS[topicOf(m.text)])
  },
  voted(_id, c) {
    const key = TOPIC_KEYS[c[0]]
    if (key) void say(ANSWERS[key])
  },
})

export { GUIDE }
