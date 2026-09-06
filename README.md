# Claudian Voice

Talk to the [Claudian](https://github.com/YishenTu/claudian) plugin instead of typing, and listen to its answers instead of reading them.

Press the microphone, say your question, stop talking — the speech is transcribed, sent into the Claudian chat, and the reply is read back out loud. There is a hands-free conversation mode too: answer ends, microphone opens again.

> **Requires the [Claudian](https://github.com/YishenTu/claudian) plugin.** This one plugs into its chat window and does nothing on its own.
> Desktop only (macOS tested).

---

## What it does

| | |
|---|---|
| 🎤 **Dictation** | Record → transcribe → the text lands in the Claudian input and is sent for you. Recording stops by itself after ~2 seconds of silence. |
| 🔊 **Speaking answers** | When Claudian finishes writing, the answer is cleaned of code, tables, links and file paths, and read aloud. |
| 🔇 **One-click mute** | A speaker button next to the microphone: coloured — answers are spoken, greyed out — screen only. Pressing it mid-sentence stops the speech immediately. |
| 🗣 **Conversation mode** | After each spoken answer the microphone opens again. Say "стоп" to leave the loop. |
| 🎛 **Voice commands** | "стоп" / "отмена" — discard what you just said. "новый чат" — start a new Claudian session. |

## Speech services

You need **one** speech-to-text key. Both providers are pay-as-you-go and neither is bundled — you bring your own.

| | Speech to text | Text to speech | Works from Russia without VPN |
|---|---|---|---|
| **Yandex SpeechKit** | yes, phrases up to 29 s | yes, 13 Russian voices | yes |
| **OpenAI** | yes (Whisper), long monologues | yes | no |
| **System voice (macOS)** | — | yes, free, offline | yes |

Text-to-speech falls back automatically: chosen engine fails → the other Yandex engine → the free system voice. It will not go silent on you.

Keys are stored in the plugin's own `data.json` on your machine and are sent to the corresponding speech service only.

## Install

**Via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (recommended)**

1. Install BRAT from Community Plugins.
2. BRAT → *Add Beta plugin* → paste `FedorovVadim/obsidian-claudian-voice`.
3. Enable **Claudian Voice** in Community Plugins.

**Manually**

Download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/claudian-voice/`, then restart Obsidian.

## Setup

1. Settings → **Claudian Voice** → pick a speech-to-text provider and paste the key.
2. Press the microphone once — macOS will ask for permission. Allow it.
3. Optional: Settings → Hotkeys → search "Claudian Voice" to bind dictation to a key.

## How it talks to Claudian

There is no API between plugins, so this one works through the interface: it writes the recognised text into the chat input, presses Enter for you, and watches the message list for a finished assistant answer (streaming badge gone, text unchanged for 1.7 s).

That means it depends on Claudian's internal class names. If Claudian renames them, the voice side stops working until this plugin is updated — nothing else breaks.

Text is collected from what is actually rendered on screen: hidden nodes, buttons, badges and service labels are skipped on purpose. They contain the raw markdown source and timing labels, which used to be read aloud as garbage.

## Interface language

Russian. The plugin was built for a Russian-speaking workflow; the code is English-commented but every user-facing string is Russian. Pull requests adding i18n are welcome.

## License

MIT © Vadim Fedorov

---

## По-русски

Плагин к [Клодиану](https://github.com/YishenTu/claudian): нажал микрофон, сказал вопрос, замолчал — текст распознался, ушёл в чат, а готовый ответ прозвучал вслух. Рядом с микрофоном кнопка-динамик: цветная — читаю вслух, серая — ответ только на экране.

Нужен один ключ распознавания речи — Яндекс SpeechKit (работает из России без VPN) или OpenAI Whisper (нужен VPN). Озвучка: живой голос Яндекса, голос OpenAI или бесплатный системный голос Mac. Если платный сервис не ответил, плагин не замолчит — дочитает системным голосом.

Установка через BRAT: адрес `FedorovVadim/obsidian-claudian-voice`. Дальше Настройки → Claudian Voice → вставить ключ.
