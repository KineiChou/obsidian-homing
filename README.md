# Homing（归位）

[简体中文](README.zh-CN.md)

A desktop Obsidian plugin that suggests folders for inbox notes and internal links while you write. Review suggestions before applying them: moving notes and inserting links always require your confirmation.

Current version: **0.2.7**. Homing was previously developed as *Note Organizer*. Requires **Obsidian 1.11.4+ on desktop**. Mobile support is not claimed.

## Get started

Build with the commands below, then copy `main.js`, `manifest.json` and `styles.css` from `dist/homing/` into a test vault's `.obsidian/plugins/homing/`. Enable it in Obsidian's community plugin settings.

Upgrading from a *Note Organizer* preview: on first start, Homing imports the settings, pending suggestions and move history from `.obsidian/plugins/note-organizer/` if its own folder is empty. It only reads the old folder. Disable and remove the old plugin afterwards so the two do not run side by side.

1. Choose an inbox and an analysis provider in settings. Supply your own service credentials, or configure a compatible local service.
2. Test the connection with a fixed synthetic example, then enable filing suggestions. Review the scope and estimated requests before analyzing existing inbox notes.
3. Open an inbox note. A small pill in the editor's top-right corner shows the suggested folder; open it to confirm or pick another folder. After filing, the pill offers Undo and the next inbox note, so you can work through the inbox without leaving the editor. You can also right-click notes in the file explorer or Notebook Navigator, or open **Organize inbox** from the status bar to review destinations and file several notes at once.
4. Run the command to find links for the current text, or separately enable automatic link suggestions. Suggested mentions get a faint dotted underline after you pause typing; hover to link, change the target or ignore. The link list still lets you insert several links in one undoable step.
5. From the keyboard: **Link or unlink at cursor…** (`homing:link-menu`) opens a list of actions for the suggestion or link under the cursor, **Accept link suggestion at cursor** (`homing:accept-link`) links a clear suggestion at once, and **Remove link at cursor** (`homing:unlink`) turns a link back into its visible text. None has a default hotkey; assign one in *Settings → Hotkeys*, or map them in Vim with the [Vimrc Support](https://github.com/esm7/obsidian-vimrc-support) plugin:

   ```vim
   exmap hominglink obcommand homing:link-menu
   nmap <Space>l :hominglink<CR>
   exmap homingunlink obcommand homing:unlink
   nmap <Space>u :homingunlink<CR>
   ```

Filing and linking share a daily request cap. Automatic links can use up to 30% of that cap, rounded down. Batch estimates use metadata only and exclude retries. Multiple candidate groups and retries can consume multiple requests for one note. Request counts are local to this device; they are not a billing limit at your provider.

## Services, network access and privacy

You provide and operate the service account or local model. Hosted services may charge for requests. Check the active provider's terms, retention and pricing before sending private notes.

Only the **active provider** receives analysis requests:

| Provider | Default destination |
| --- | --- |
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| OpenAI-compatible | `https://api.openai.com/v1/chat/completions` |
| Anthropic | `https://api.anthropic.com/v1/messages` |
| Ollama | `http://127.0.0.1:11434/v1/chat/completions` |

For **OpenRouter**, select it as the analysis provider, link an OpenRouter API key, and use a full model ID such as the default `openai/gpt-4.1-mini`. Choose a model that supports [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs). The plugin requires a route that supports its structured response parameters. Switching providers clears the selected key; choose the new service's key before checking the connection.

Compatible providers accept a custom base URL. For a local Ollama installation, select **Ollama**, supply its base URL and an installed model ID, and leave the saved key blank. Its default model is `qwen3:1.7b`; remote endpoints still require a key. The plugin does not install or start a model service. A local endpoint receives the same content described below; whether it forwards that content elsewhere depends on that service. No provider fallback silently sends notes to a different service.

What an analysis request can contain:

- **Filing:** the current note's title, tags, and body without its frontmatter block; candidate folder paths, configured purposes and inherited rules. Analysis on opening reads that note's saved content; manual analysis of the active note can include unsaved editor text. The default long-note policy extracts a bounded excerpt locally, using headings, the opening and section starts. It does not call a separate summarization model. Full-body mode sends the body when it fits the request budget and refuses oversized requests.
- **Optional folder profiles:** when enabled, candidate descriptions may also include sampled titles and tags from other notes in each folder. These profiles do not send those notes' bodies. This option is off by default.
- **Link suggestions:** clear title and alias matches are found and shown locally, without any request. Only when you hover an ambiguous suggestion, pause while typing `[[?`, run the find-links command, or turn on background checks is the mention sent with its local sentence (or line), the source note path, and candidate notes' paths, titles, aliases, tags and description/summary metadata. This can include unsaved editor text. Turn off **Check ambiguous links on request** to never send hover or `[[?` requests. The link index does not send every note's full body or create embeddings.
- **Connection tests:** a fixed synthetic example, without vault text.

To find inbox notes, destination folders and link targets, the plugin lists the vault's files and folders and reads Markdown metadata locally. That list stays on your device; only the candidates described above are included in a request.

The plugin does not collect telemetry. Credentials are read through Obsidian's secret storage; settings retain the secret name rather than the key. Notes and complete requests are not written to diagnostic logs. Minimal filing suggestions, settings and move history are stored locally in plugin data; normal vault synchronization may synchronize that data. Saved suggestions contain paths, content fingerprints and classification metadata, not note bodies. Valid suggestions restore without contacting the provider; existing inbox notes remain waiting until you select them for analysis or open one that has no suggestion yet (the **Analyze an inbox note when you open it** option, on by default with automatic filing).

If an analysis failed or found no suitable folder, leaving and reopening that note starts another attempt. Notes with a suggested folder, requests already in progress and ignored notes are not resubmitted. Retries use the same daily request allowance.

## Current limits

One inbox, Markdown notes, desktop only. Link discovery starts from filenames and aliases, so it does not discover every semantic relationship. Suggestions can be wrong, and a provider's ranking is not a calibrated confidence score. Review destinations and links before confirming.

Moves that cannot preserve references safely are refused. If a move has already occurred but link updates cannot be verified, its record requires review; the plugin does not automatically move it back. Move undo is limited to the current plugin session. Restart recovery archives resolved operations and leaves ambiguous moves for review.

Automated tests cover domain logic and editor/HTTP/UI substitutes. In an Obsidian 1.13.7 synthetic vault, host checks covered folder selection, a move with incoming and outgoing links, both link updates, move undo, filing-banner actions, and two link insertions restored by one native Undo. The batch-link check used a local mock HTTP response, not a real model. Paired Jev evaluations used synthetic examples. A real local Ollama `qwen3:1.7b` returned four valid responses but made one incorrect filing choice; its native connection check passed. This verifies protocol compatibility, not recommendation quality in real writing workflows. The project owner completed the host acceptance checklist for 0.2.5 on 2026-09-25 ([#15](https://github.com/KineiChou/obsidian-homing/issues/15)). Other host versions remain unverified. See the [Ollama results](docs/ollama-acceptance.md). See [validation scope](docs/validation.md) and [release requirements](docs/releasing.md).

## Development

Node.js 22.21.1 and npm 11.6.2 are used by the release workflow.

```sh
npm install --global npm@11.6.2
npm ci --ignore-scripts
npm run check
npm run package
```

`npm run package` builds `dist/homing/` (including `LICENSE` and `NOTICE`); it does not install into a vault or publish anything. `npm run dev` watches source files. See [development contracts](docs/development.md), [interaction design](docs/interaction-design.md), [folder classification](docs/folder-classification.md), [link suggestions](docs/link-suggestions.md) and the [link matching algorithm](docs/link-matching.md) (`npm run benchmark:links`).

## License

Copyright 2026 KineiChou. Licensed under the [Apache License 2.0](LICENSE).

You may use, modify and redistribute Homing, including in modified form. Redistributions must keep the copyright notice and the [NOTICE](NOTICE) file crediting KineiChou, include the license, and state which files you changed.
