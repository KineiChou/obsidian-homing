import { App, Modal, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { OrganizerController } from './types';
import { PROVIDER_DEFAULTS, type DecisionProvider, type OrganizerSettings, type FolderRule, type LinkHintStyle } from '../settings';
import { errorText, t, translateMessage } from '../i18n';
import { button, details, node } from './dom';
import { CreateInboxModal, TargetPicker } from './target-picker';

export class OrganizerSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly controller: OrganizerController) { super(app, plugin); }
  display(): void { this.containerEl.replaceChildren(); renderSettings(this.containerEl, this.app, this.controller); }
}
export function renderSettings(container: HTMLElement, app: App, controller: OrganizerController): void {
  container.classList.add('note-organizer', 'note-organizer-settings');
  const status = node(container, 'p', '', 'note-organizer-feedback'); status.setAttribute('role', 'status');
  const save = async (patch: Partial<OrganizerSettings>) => { try { await controller.saveSettings(patch); status.textContent = ''; } catch (error) { status.textContent = errorText(error); throw error; } };
  const change = (patch: Partial<OrganizerSettings>) => { void save(patch).catch(() => undefined); };
  new Setting(container).setName(t('settings.start')).setHeading();
  const inbox = new Setting(container).setName(t('settings.inbox')).setDesc(controller.settings().inbox || t('settings.inboxHelp'));
  inbox.addButton(control => control.setButtonText(t('settings.chooseFolder')).onClick(() => new TargetPicker(app, controller.allFolders(), path => path, path => {
    // Setting has a fluent then() method; returning it would recursively resolve the promise.
    void save({ inbox: path }).then((): void => { inbox.setDesc(path); }).catch(() => undefined);
  }).open()));
  inbox.addExtraButton(control => control.setIcon('folder-plus').setTooltip(t('picker.createInbox')).onClick(() => new CreateInboxModal(app, async path => { await controller.createInbox(path); inbox.setDesc(path); }).open()));
  new Setting(container).setName(t('settings.provider')).setDesc(t('settings.providerHelp')).addDropdown(dropdown => {
    for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) dropdown.addOption(provider, defaults.name);
    dropdown.setValue(controller.settings().provider).onChange(value => {
      const provider = value as DecisionProvider;
      void save({ provider, endpoint: PROVIDER_DEFAULTS[provider].endpoint, modelId: PROVIDER_DEFAULTS[provider].modelId, secretName: '' }).then(() => { container.replaceChildren(); renderSettings(container, app, controller); }).catch(() => undefined);
    });
  });
  const configuration = controller.settings();
  const connectionDescription = node(container, 'p', t('settings.connectionHelp', { provider: PROVIDER_DEFAULTS[configuration.provider].name, endpoint: configuration.endpoint }), 'note-organizer-muted');
  if (configuration.provider !== 'jev') {
    new Setting(container).setName(t('settings.endpoint')).addText(input => { input.setValue(configuration.endpoint); input.inputEl.addEventListener('change', () => { void save({ endpoint: input.getValue().trim() }).then(() => { connectionDescription.textContent = t('settings.connectionHelp', { provider: PROVIDER_DEFAULTS[controller.settings().provider].name, endpoint: controller.settings().endpoint }); }).catch(() => undefined); }); });
    new Setting(container).setName(t('settings.model')).addText(input => { input.setValue(configuration.modelId); input.inputEl.addEventListener('change', () => change({ modelId: input.getValue().trim() })); });
  }
  const key = new Setting(container).setName(t('settings.key')).setDesc(t(configuration.provider === 'ollama' ? 'settings.localKeyHelp' : 'settings.keyHelp'));
  new SecretComponent(app, key.controlEl).setValue(configuration.secretName).onChange(name => change({ secretName: name }));
  new Setting(container).setName(t('settings.connection')).setDesc(t('settings.enableHelp')).addButton(control => control.setButtonText(t(controller.enabled() ? 'settings.check' : 'settings.enable')).setCta().onClick(async () => {
    if (!controller.settings().inbox) { status.textContent = t('organizer.pickInbox'); return; }
    control.setDisabled(true); status.textContent = t('settings.checking');
    try { await controller.testConnection(); controller.setEnabled(true); control.setButtonText(t('settings.check')); status.textContent = t('settings.connected'); if (options instanceof HTMLDetailsElement) options.open = true; }
    catch (error) { status.textContent = errorText(error); }
    finally { control.setDisabled(false); }
  }));
  const options = configuration.inbox ? container : details(container, t('settings.options'));
  new Setting(options).setName(t('settings.automation')).setHeading();
  new Setting(options).setName(t('settings.autoFiling')).setDesc(t('settings.autoFilingHelp')).addToggle(toggle => toggle.setValue(configuration.autoFiling).onChange(value => change({ autoFiling: value })));
  new Setting(options).setName(t('settings.autoLinks')).setDesc(t('settings.autoLinksHelp')).addToggle(toggle => toggle.setValue(configuration.autoLinks).onChange(value => change({ autoLinks: value })));
  new Setting(options).setName(t('settings.display')).setHeading();
  new Setting(options).setName(t('settings.linkHints')).setDesc(t('settings.linkHintsHelp')).addDropdown(dropdown => dropdown.addOption('underline', t('settings.hintUnderline')).addOption('marker', t('settings.hintMarker')).addOption('off', t('settings.hintOff')).setValue(configuration.linkHints).onChange(value => change({ linkHints: value as LinkHintStyle })));
  new Setting(options).setName(t('settings.explorerMarkers')).setDesc(t('settings.explorerMarkersHelp')).addToggle(toggle => toggle.setValue(configuration.explorerMarkers).onChange(value => change({ explorerMarkers: value })));
  const advanced = node(options, 'details');
  new Setting(node(advanced, 'summary')).setName(t('settings.scope')).setHeading();
  new Setting(advanced).setName(t('settings.subfolders')).addToggle(toggle => toggle.setValue(configuration.includeSubfolders).onChange(value => change({ includeSubfolders: value })));
  new Setting(advanced).setName(t('settings.linkScope')).addDropdown(dropdown => dropdown.addOption('vault', t('settings.vault')).addOption('inbox', t('settings.inboxOnly')).setValue(configuration.linkScope).onChange(value => change({ linkScope: value as 'vault' | 'inbox' })));
  new Setting(advanced).setName(t('settings.excluded')).setDesc(t('settings.excludedHelp')).addTextArea(input => { input.setValue(configuration.excludedPaths.join('\n')); input.inputEl.rows = 3; input.inputEl.addEventListener('change', () => change({ excludedPaths: input.getValue().split('\n').map(path => path.trim()).filter(Boolean) })); });
  new Setting(advanced).setName(t('settings.destinations')).setDesc(t('settings.destinationsHelp')).addTextArea(input => { input.setValue(configuration.excludedDestinations.join('\n')); input.inputEl.rows = 3; input.inputEl.addEventListener('change', () => change({ excludedDestinations: input.getValue().split('\n').map(path => path.trim()).filter(Boolean) })); });
  const usage = controller.usage();
  new Setting(advanced).setName(t('settings.limit')).setDesc(t('settings.usage', { requests: usage.requests, tokens: usage.inputTokens, unknown: usage.unknownRequests })).addText(input => { input.setValue(String(configuration.dailyRequestLimit)); input.inputEl.type = 'number'; input.inputEl.min = '1'; input.inputEl.max = '10000'; input.inputEl.addEventListener('change', () => change({ dailyRequestLimit: Number(input.getValue()) })); });
  new Setting(advanced).setName(t('settings.excerpt')).setDesc(t('settings.excerptHelp')).addToggle(toggle => toggle.setValue(configuration.longNoteStrategy === 'excerpt').onChange(value => change({ longNoteStrategy: value ? 'excerpt' : 'full' })));
  new Setting(advanced).setName(t('settings.profiles')).setDesc(t('settings.profilesHelp')).addToggle(toggle => toggle.setValue(configuration.folderProfilesEnabled).onChange(value => change({ folderProfilesEnabled: value })));
  new Setting(advanced).setName(t('settings.purpose')).setDesc(t('settings.purposeHelp')).addButton(control => control.setButtonText(t('settings.chooseFolder')).onClick(() => new TargetPicker(app, controller.allFolders().filter(path => path !== controller.settings().inbox), path => path, path => new FolderRuleModal(app, controller, path).open()).open()));
  const manage = node(options, 'details');
  new Setting(node(manage, 'summary')).setName(t('settings.manage')).setHeading();
  new Setting(manage).setName(t('settings.restore')).setDesc(t('settings.restoreHelp')).addButton(control => control.setButtonText(t('settings.restoreAction')).onClick(() => { controller.restoreIgnored(); status.textContent = t('settings.restored'); }));
  renderHistory(node(manage, 'div', undefined, 'note-organizer-history'), controller);
  new Setting(manage).setName(t('settings.pause')).setDesc(t('settings.pauseHelp')).addToggle(toggle => toggle.setValue(!controller.enabled()).onChange(paused => controller.setEnabled(!paused)));
}
/** Recent moves live with other management tools; the editor pill keeps the latest undo at hand. */
function renderHistory(container: HTMLElement, controller: OrganizerController): void {
  const render = () => {
    container.replaceChildren();
    new Setting(container).setName(t('organizer.recent')).setHeading();
    const records = controller.recentMoves().slice(-20).reverse();
    if (!records.length) node(container, 'p', t('settings.historyEmpty'), 'note-organizer-muted');
    for (const record of records) {
      const row = node(container, 'div', undefined, 'note-organizer-recent'); node(row, 'span', record.to, 'note-organizer-path');
      const run = (action: () => Promise<void>) => { void action().then(render).catch(error => { node(row, 'span', errorText(error), 'note-organizer-feedback'); }); };
      if (record.status === 'done') button(row, t('organizer.undo'), () => run(() => controller.undoMove(record.id)));
      else if (record.status === 'review' || record.status === 'intent') { node(row, 'span', record.message ? translateMessage(record.message) : t('organizer.needsReview'), 'note-organizer-muted'); if (record.status === 'review') button(row, t('organizer.acknowledge'), () => run(() => controller.acknowledgeMove(record.id))); }
      else node(row, 'span', t(record.status === 'archived' ? 'organizer.archived' : 'organizer.undone'), 'note-organizer-muted');
    }
  };
  render();
}
class FolderRuleModal extends Modal {
  constructor(app: App, private readonly controller: OrganizerController, private readonly path: string) { super(app); }
  onOpen(): void {
    this.setTitle(this.path);
    const existing = this.controller.settings().folderRules.find(rule => rule.path === this.path);
    let purpose = existing?.purpose ?? '', acceptsNotes = existing?.acceptsNotes ?? true, subtreeRules = existing?.subtreeRules.join('\n') ?? '';
    new Setting(this.contentEl).setName(t('rule.purpose')).addTextArea(input => input.setValue(purpose).onChange(value => { purpose = value; }));
    new Setting(this.contentEl).setName(t('rule.accepts')).addToggle(toggle => toggle.setValue(acceptsNotes).onChange(value => { acceptsNotes = value; }));
    new Setting(this.contentEl).setName(t('rule.subtree')).setDesc(t('rule.subtreeHelp')).addTextArea(input => input.setValue(subtreeRules).onChange(value => { subtreeRules = value; }));
    const status = node(this.contentEl, 'p'); status.setAttribute('role', 'status');
    const save = button(this.contentEl, t('rule.save'), () => {
      const rule: FolderRule = { path: this.path, purpose, acceptsNotes, subtreeRules: subtreeRules.split('\n').map(value => value.trim()).filter(Boolean) };
      save.disabled = true;
      void this.controller.saveSettings({ folderRules: [...this.controller.settings().folderRules.filter(item => item.path !== this.path), rule] }).then(() => this.close()).catch(error => { status.textContent = errorText(error); save.disabled = false; });
    }, true);
  }
}
