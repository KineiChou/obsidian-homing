# Note Organizer

[简体中文](README.zh-CN.md)

A desktop Obsidian plugin that suggests folders for inbox notes and internal links while you write. Review suggestions before applying them: moving notes and inserting links always require your confirmation.

This is a **development preview**, not a community-store release. Note Organizer is a working name; the final name, author attribution and license remain undecided. Requires **Obsidian 1.11.4+ on desktop**. Mobile support is not claimed.

## Get started

Build with the commands below, then copy `main.js`, `manifest.json` and `styles.css` from `dist/note-organizer/` into a test vault's `.obsidian/plugins/note-organizer/`. Enable it in Obsidian's community plugin settings.

1. Choose an inbox and an analysis provider in settings. Supply your own service credentials, or configure a compatible local service.
2. Test the connection with a fixed synthetic example, then enable filing suggestions. Review the scope and estimated requests before analyzing existing inbox notes.
3. Open the organizer from the status bar to review note content and destinations. Confirm a suggested folder or choose another destination before moving a note.
4. Run the command to find links for the current text, or separately enable automatic link suggestions. Select the suggestions to insert together; one editor undo restores the batch.

Filing and linking share a daily request cap. Automatic links also have a separate allowance within that cap. Multiple candidate groups and retries can consume multiple requests for one note. Request counts are local to this device; they are not a billing limit at your provider.

## Services, network access and privacy

You provide and operate the service account or local model. Hosted services may charge for requests. Check the active provider's terms, retention and pricing before sending private notes.

Only the **active provider** receives analysis requests:

| Provider | Default destination |
| --- | --- |
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` |
| OpenAI-compatible | `https://api.openai.com/v1/chat/completions` |
| Anthropic | `https://api.anthropic.com/v1/messages` |

Compatible providers accept a custom base URL. For example, an independently installed Ollama service can use `http://localhost:11434/v1` with the OpenAI-compatible provider. The plugin does not install or start a model service. A local endpoint receives the same content described below; whether it forwards that content elsewhere depends on that service. No provider fallback silently sends notes to a different service.

What an analysis request can contain:

- **Filing:** the current note's title, tags, and body without its frontmatter block; candidate folder paths, configured purposes and inherited rules. The default long-note policy extracts a bounded excerpt locally, using headings, the opening and section starts. It does not call a separate summarization model. Full-body mode sends the body when it fits the request budget and refuses oversized requests.
- **Optional folder profiles:** when enabled, candidate descriptions may also include sampled titles and tags from other notes in each folder. These profiles do not send those notes' bodies. This option is off by default.
- **Link suggestions:** the mention, its local sentence, the source note path, and candidate notes' paths, titles, aliases, tags and description/summary metadata. This can include unsaved editor text. The link index does not send every note's full body or create embeddings.
- **Connection tests:** a fixed synthetic example, without vault text.

The plugin does not collect telemetry. Credentials are read through Obsidian's secret storage; settings retain the secret name rather than the key. Notes and complete requests are not written to diagnostic logs. Suggestions, settings and move history are stored locally in plugin data; normal vault synchronization may synchronize that data.

## Current limits

One inbox, Markdown notes, desktop only. Link discovery starts from filenames and aliases, so it does not discover every semantic relationship. Suggestions can be wrong, and a provider's ranking is not a calibrated confidence score. Review destinations and links before confirming.

Moves that cannot preserve references safely are refused. Move undo is limited to the current plugin session. Restart recovery reconciles completed operations and leaves ambiguous moves for review.

Automated tests cover domain logic and editor/HTTP/UI substitutes. Earlier Jev smoke checks used synthetic examples. Real Obsidian host acceptance, local-model operation and recommendation quality across real writing workflows are not established by those tests. See [validation scope](docs/validation.md) and [release requirements](docs/releasing.md).

## Development

Node.js 22.21.1 and npm 11.6.2 are used by the release workflow.

```sh
npm install --global npm@11.6.2
npm ci --ignore-scripts
npm run check
npm run package
```

`npm run package` builds `dist/note-organizer/`; it does not install into a vault or publish anything. `npm run dev` watches source files. See [development contracts](docs/development.md), [interaction design](docs/interaction-design.md), [folder classification](docs/folder-classification.md) and [link suggestions](docs/link-suggestions.md).
