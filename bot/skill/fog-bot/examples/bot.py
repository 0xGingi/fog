#!/usr/bin/env python3
"""A complete fog-bot bot in plain Python (standard library only).

    FOG_BOT_TOKEN=$(fog-bot token) python3 bot.py

It shows the whole loop: commands in the / menu, a streamed reply, buttons, a dropdown, a form, and
files both ways. Replace `reply()` with your agent.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("FOG_BOT_URL", "http://127.0.0.1:8790")
TOKEN = os.environ["FOG_BOT_TOKEN"]


def call(method, path, body=None, raw=None, content_type=None, timeout=70):
    """One API call. Returns the decoded JSON (or bytes for file downloads); raises on HTTP errors."""
    headers = {"Authorization": f"Bearer {TOKEN}"}
    data = None
    if body is not None:
        data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    elif raw is not None:
        data, headers["Content-Type"] = raw, content_type or "application/octet-stream"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = r.read()
        return json.loads(payload) if r.headers.get_content_type() == "application/json" else payload


def q(s):
    """Chat and message ids go in URLs; group ids contain ':'."""
    return urllib.parse.quote(s, safe="")


def send(chat, text, **extra):
    return call("POST", f"/v1/chats/{q(chat)}/messages", {"text": text, **extra})["message"]


def edit(chat, msg_id, **fields):
    return call("PATCH", f"/v1/chats/{q(chat)}/messages/{q(msg_id)}", fields)


def reply(text):
    """Your agent goes here. This one just talks back, a few words at a time."""
    return f"You said: **{text}**\n\nTry `/buttons`, `/form` or send me a file."


def stream(chat, text, thread=None):
    """Show a reply as it's being written: send it `live`, edit it, then finish with live=False."""
    words = text.split(" ")
    msg = send(chat, words[0], live=True, **({"thread_id": thread} if thread else {}))
    for i in range(1, len(words) + 1, 3):
        edit(chat, msg["id"], text=" ".join(words[:i]))
        time.sleep(0.15)
    edit(chat, msg["id"], text=text, live=False)


def on_message(m):
    chat, text, thread = m["chat"]["id"], m.get("text", ""), (m.get("thread") or {}).get("id")
    where = {"thread_id": thread} if thread else {}
    # In groups, only answer when mentioned (or inside a thread).
    if m["chat"]["type"] == "group" and not m.get("mentions_me") and not thread:
        return
    call("POST", f"/v1/chats/{q(chat)}/typing")
    if text.startswith("/buttons"):
        send(chat, "Deploy to production?", card={"title": "Approval needed", "color": "#e0a030"}, buttons=[
            [{"text": "Deploy", "data": "deploy:yes", "style": "primary"}, {"text": "Cancel", "data": "deploy:no", "style": "danger"}],
            {"select": {"id": "env", "placeholder": "Or pick an environment", "options": [
                {"label": "Staging", "value": "staging"}, {"label": "Production", "value": "prod"}]}},
        ], **where)
    elif text.startswith("/form"):
        send(chat, "I need a code to continue.", buttons=[[{"text": "Enter code", "data": "ask:code"}]], **where)
    elif m.get("attachment"):
        a = m["attachment"]
        data = call("GET", f"/v1/files/{q(a['file_id'])}")
        up = call("POST", f"/v1/files?name={q('copy-' + a['name'])}&kind={a['kind']}", raw=data, content_type=a["mime"])
        send(chat, f"Got **{a['name']}** ({len(data)} bytes). Here it is back:", file_id=up["file"]["file_id"], reply_to=m["id"], **where)
    else:
        stream(chat, reply(text), thread)
    call("POST", f"/v1/chats/{q(chat)}/read")


def on_button(e):
    answer = lambda **a: call("POST", f"/v1/buttons/{q(e['query_id'])}/answer", a)
    chat, msg = e["chat"]["id"], e["message_id"]
    if e["data"].startswith("deploy:"):
        go = e["data"] == "deploy:yes"
        answer(text="Deploying…" if go else "Cancelled")
        # Settle the card so it can't be tapped twice.
        edit(chat, msg, buttons=None, card={"title": "Deployed" if go else "Cancelled", "color": "#2e9d5b" if go else "#888888"})
    elif e["data"] == "env":
        answer(text=f"Environment: {e['values'][0]}")
    elif e["data"] == "ask:code":
        answer(form={"id": "code", "title": "One-time code", "fields": [
            {"id": "code", "label": "Code", "placeholder": "6 digits", "secret": True, "required": True, "min_length": 6, "max_length": 6}]})
    elif e["data"] == "code":  # the form came back
        answer(text="Thanks, code received.", alert=True)


def main():
    call("PATCH", "/v1/me", {"about": "Example bot: try /buttons or /form"})
    call("PUT", "/v1/commands", {"commands": [
        {"name": "buttons", "description": "Show buttons and a dropdown"},
        {"name": "form", "description": "Ask for a code in a form"},
    ]})
    # Start from now: don't replay old events (taps in them would have expired anyway).
    offset = call("GET", "/v1/events?offset=-1")["next"]
    print("listening…")
    while True:
        try:
            r = call("GET", f"/v1/events?offset={offset}&timeout=30")
        except (urllib.error.URLError, TimeoutError) as err:  # fog-bot restarting: try again shortly
            print("waiting for fog-bot:", err)
            time.sleep(3)
            continue
        for e in r["events"]:
            try:
                if e["type"] == "message":
                    on_message(e["message"])
                elif e["type"] == "button":
                    on_button(e)
            except urllib.error.HTTPError as err:
                print("API error:", err.code, err.read().decode()[:200])
        offset = r["next"]  # confirms everything handled so far


if __name__ == "__main__":
    main()
