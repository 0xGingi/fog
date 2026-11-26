// What a bot can ask for after you tap one of its buttons: a form to fill in, or a note to read.
import { useState } from 'react'
import * as fog from './fog'
import { useFog } from './fog'
import { Button, Dialog } from './ui'

export function BotDialogs() {
  const form = useFog((s) => s.form)
  const alert = useFog((s) => s.alert)
  return (
    <>
      {form && <FormDialog key={`${form.msg}/${form.form.id}`} {...form} />}
      {alert && !form && (
        <Dialog title={fog.personName(alert.from)} onClose={fog.closeAlert} actions={<Button onClick={fog.closeAlert}>OK</Button>}>
          <p className="text-[15px] whitespace-pre-wrap">{alert.text}</p>
        </Dialog>
      )}
    </>
  )
}

function FormDialog({ chat, msg, bot, form }: NonNullable<fog.State['form']>) {
  const [values, setValues] = useState<Record<string, string>>({})
  const missing = form.f.find((f) => {
    const v = (values[f.id] ?? '').trim()
    return (f.req && !v) || (v && f.min && v.length < f.min)
  })
  const submit = () => {
    if (missing) return
    fog.closeForm()
    fog.tap(chat, msg, bot, form.id, { f: Object.fromEntries(form.f.map((f) => [f.id, values[f.id] ?? ''])) })
  }
  return (
    <Dialog
      title={form.title}
      onClose={fog.closeForm}
      actions={
        <>
          <Button kind="ghost" onClick={fog.closeForm}>
            Cancel
          </Button>
          <Button disabled={!!missing} onClick={submit}>
            Send
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <p className="text-[13px] text-muted">Goes only to {fog.personName(bot)}, end-to-end encrypted.</p>
        {form.f.map((f, i) => {
          const common = {
            id: `bf-${f.id}`,
            value: values[f.id] ?? '',
            placeholder: f.ph,
            maxLength: f.max,
            required: f.req,
            autoFocus: i === 0,
            autoComplete: 'off',
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues({ ...values, [f.id]: e.target.value }),
            className: 'w-full rounded-xl bg-raised px-3.5 py-2.5 text-base outline-none ring-1 ring-transparent focus:ring-lamp/50',
          }
          return (
            <label key={f.id} htmlFor={common.id} className="block">
              <span className="mb-1 block text-sm font-semibold">
                {f.l}
                {f.req && <span className="text-muted"> (required)</span>}
              </span>
              {f.long ? <textarea {...common} rows={4} className={`${common.className} resize-y`} /> : <input {...common} type={f.secret ? 'password' : 'text'} />}
            </label>
          )
        })}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
