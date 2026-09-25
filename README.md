# Homing（归位）

[简体中文](README.zh-CN.md)

An Obsidian plugin that suggests a folder for each note in your inbox and suggests internal links while you write. Nothing moves and no link is inserted until you confirm it.

Requires **Obsidian 1.11.4 or later on desktop**.

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **Homing**, then install and enable it.

To install manually, download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/KineiChou/obsidian-homing/releases/latest) into `<your vault>/.obsidian/plugins/homing/`, then enable Homing under **Community plugins**.

## Get started

1. In Homing's settings, choose your inbox folder and an analysis provider. Link your own API key, or point it at a local model.
2. Test the connection, then turn on filing suggestions. Existing inbox notes are only analyzed when you choose them; you see how many requests that will take first.
3. Open an inbox note. A small pill in the editor's top-right corner shows the suggested folder. Open it to confirm or pick another folder. After filing, the pill offers **Undo** and **Next**, so you can work through the inbox without leaving the editor.
4. To file several notes at once, open **Organize inbox** from the status bar, or right-click notes in the file explorer or Notebook Navigator.
5. For links, pause while typing: mentions of your existing notes get a faint underline. Hover to link, change the target or ignore it. Type `[[?` to search for a note to link, or run **Find links for current text** to add several links in one undoable step.

### Keyboard

| Command | What it does |
| --- | --- |
| **Link or unlink at cursor…** (`homing:link-menu`) | Opens a list of actions for the suggestion or link under the cursor |
| **Accept link suggestion at cursor** (`homing:accept-link`) | Links a clear suggestion right away |
| **Remove link at cursor** (`homing:unlink`) | Turns a link back into its visible text |

None has a default hotkey. Assign one in **Settings → Hotkeys**, or map them in Vim with [Vimrc Support](https://github.com/esm7/obsidian-vimrc-support):

```vim
exmap hominglink obcommand homing:link-menu
nmap <Space>l :hominglink<CR>
exmap homingunlink obcommand homing:unlink
nmap <Space>u :homingunlink<CR>
```

## Providers, privacy and cost

You bring the service account or the local model. Hosted services may charge per request, so check your provider's pricing, terms and data retention before sending private notes.

Only the provider you select receives requests:

| Provider | Default endpoint |
| --- | --- |
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| OpenAI-compatible | `https://api.openai.com/v1/chat/completions` |
| Anthropic | `https://api.anthropic.com/v1/messages` |
| Ollama | `http://127.0.0.1:11434/v1/chat/completions` |

- **OpenRouter:** link an OpenRouter API key and enter a full model ID (default `openai/gpt-4.1-mini`). Pick a model that supports [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
- **Ollama:** enter the base URL and an installed model ID (default `qwen3:1.7b`). A local endpoint needs no key; a remote one does. Homing doesn't install or start the model.
- Compatible providers accept a custom base URL. Switching providers clears the selected key.
- Homing asks the model for structured output. If a service doesn't support it, Homing retries that request once in plain JSON mode, which counts as another request. It never switches to a different provider on its own.

What a request can contain:

- **Filing:** the note's title, tags and body (without frontmatter), plus your folder paths, their purposes and rules. Long notes are shortened locally to an excerpt of headings, the opening and section starts, unless you choose full-body mode.
- **Folder profiles (optional, off by default):** sampled titles and tags of other notes in each candidate folder, never their bodies.
- **Links:** clear title and alias matches are found locally and send nothing. Only when you hover an ambiguous suggestion, pause in `[[?`, run the find-links command or turn on background checks is the mention sent, with its sentence, the source note's path and the candidate notes' paths, titles, aliases, tags and descriptions. Turn off **Check ambiguous links on request** to never send hover or `[[?` requests.
- **Connection test:** a fixed example, no vault text.

To find inbox notes, folders and link targets, Homing lists your vault's files and reads Markdown metadata on your device. That list stays local; a request only contains what is listed above.

Homing collects no telemetry. API keys stay in Obsidian's secret storage; settings only keep the key's name. Suggestions, settings and move history are saved in the plugin's data folder (paths, content fingerprints and folder choices, never note bodies), which your vault sync may copy.

Filing and linking share a daily request cap (100 by default); automatic link checks can use up to 30% of it. The count is kept on this device and is not your provider's billing limit.

## Limits

- One inbox, Markdown notes, desktop only.
- Link suggestions start from note titles and aliases, so Homing won't find every related note.
- Suggestions can be wrong, and the probabilities a model reports are not a calibrated confidence. Check the destination or link before you confirm.
- A move that could break links is refused. Undo is available until you restart Obsidian.

## License

Copyright 2026 KineiChou. Licensed under the [Apache License 2.0](LICENSE).

You may use, modify and redistribute Homing, including modified versions. Redistributions must keep the copyright notice and the [NOTICE](NOTICE) file crediting KineiChou, include the license, and state which files you changed.

Building from source and design notes: [docs/development.md](docs/development.md).
