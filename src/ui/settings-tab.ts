import { App, Modal, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { OrganizerController } from './types';
import { PROVIDER_DEFAULTS, type DecisionProvider, type OrganizerSettings, type FolderRule, type LinkHintStyle } from '../settings';
import { errorText, t } from '../i18n';
import { button, details, node } from './dom';
import { CreateInboxModal, TargetPicker } from './target-picker';
import { HistoryModal } from './history-modal';

export class OrganizerSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly controller: OrganizerController) { super(app, plugin); }
  display(): void { this.containerEl.replaceChildren(); renderSettings(this.containerEl, this.app, this.controller); }
}
type Save = (patch: Partial<OrganizerSettings>) => Promise<void>;

export function renderSettings(container: HTMLElement, app: App, controller: OrganizerController): void {
  container.classList.add('note-organizer', 'note-organizer-settings');
  const status = node(container, 'p', '', 'note-organizer-feedback note-organizer-settings-status'); status.setAttribute('role', 'status');
  const save: Save = async patch => { try { await controller.saveSettings(patch); status.textContent = ''; } catch (error) { status.textContent = errorText(error); throw error; } };
  const change = (patch: Partial<OrganizerSettings>) => { void save(patch).catch(() => undefined); };
  const configuration = controller.settings();
  const sending = () => t('settings.connectionHelp', { provider: PROVIDER_DEFAULTS[controller.settings().provider].name, endpoint: controller.settings().endpoint }) + ' ' + t('settings.providerHelp');

  new Setting(container).setName(t('settings.start')).setHeading();
  const inbox = new Setting(container).setName(t('settings.inbox')).setDesc(configuration.inbox || t('settings.inboxHelp'));
  inbox.addButton(control => control.setButtonText(t('settings.chooseFolder')).onClick(() => new TargetPicker(app, controller.allFolders(), path => path, path => {
    // Setting has a fluent then() method; returning it would recursively resolve the promise.
    void save({ inbox: path }).then((): void => { inbox.setDesc(path); }).catch(() => undefined);
  }).open()));
  inbox.addExtraButton(control => control.setIcon('folder-plus').setTooltip(t('picker.createInbox')).onClick(() => new CreateInboxModal(app, async path => { await controller.createInbox(path); inbox.setDesc(path); }).open()));
  const provider = new Setting(container).setName(t('settings.provider')).setDesc(sending()).addDropdown(dropdown => {
    for (const [id, defaults] of Object.entries(PROVIDER_DEFAULTS)) dropdown.addOption(id, defaults.name);
    dropdown.setValue(configuration.provider).onChange(value => {
      const next = value as DecisionProvider;
      void save({ provider: next, endpoint: PROVIDER_DEFAULTS[next].endpoint, modelId: PROVIDER_DEFAULTS[next].modelId, secretName: '' }).then(() => { container.replaceChildren(); renderSettings(container, app, controller); }).catch(() => undefined);
    });
  });
  if (configuration.provider !== 'jev') {
    new Setting(container).setName(t('settings.endpoint')).addText(input => { input.setValue(configuration.endpoint); input.inputEl.addEventListener('change', () => { void save({ endpoint: input.getValue().trim() }).then(() => { provider.setDesc(sending()); }).catch(() => undefined); }); });
    new Setting(container).setName(t('settings.model')).setDesc(configuration.provider === 'openrouter' ? t('settings.openrouterModelHelp') : '').addText(input => { input.setValue(configuration.modelId); input.inputEl.addEventListener('change', () => change({ modelId: input.getValue().trim() })); });
  }
  const key = new Setting(container).setName(t('settings.key')).setDesc(t(configuration.provider === 'ollama' ? 'settings.localKeyHelp' : 'settings.keyHelp'));
  new SecretComponent(app, key.controlEl).setValue(configuration.secretName).onChange(name => change({ secretName: name }));
  const usage = () => { const today = controller.usage(); return t('settings.connectedStatus', { requests: today.requests, limit: controller.settings().dailyRequestLimit }); };
  const connection = new Setting(container).setName(t('settings.connection')).setDesc(controller.enabled() ? usage() : t('settings.enableHelp'));
  connection.addButton(control => control.setButtonText(t(controller.enabled() ? 'settings.check' : 'settings.enable')).setCta().onClick(async () => {
    if (!controller.settings().inbox) { status.textContent = t('organizer.pickInbox'); return; }
    control.setDisabled(true); status.textContent = t('settings.checking');
    try { await controller.testConnection(); controller.setEnabled(true); control.setButtonText(t('settings.check')); connection.setDesc(usage()); status.textContent = t('settings.connected'); if (folded) folded.open = true; }
    catch (error) { status.textContent = errorText(error); }
    finally { control.setDisabled(false); }
  }));

  // Until an inbox exists, everything else stays folded so the first run is only the essentials.
  const folded = configuration.inbox ? null : details(container, t('settings.options')), options = folded ?? container;
  new Setting(options).setName(t('settings.automation')).setHeading();
  new Setting(options).setName(t('settings.autoFiling')).setDesc(t('settings.autoFilingHelp')).addToggle(toggle => toggle.setValue(configuration.autoFiling).onChange(value => change({ autoFiling: value })));
  new Setting(options).setName(t('settings.analyzeOnOpen')).setDesc(t('settings.analyzeOnOpenHelp')).addToggle(toggle => toggle.setValue(configuration.analyzeOnOpen).onChange(value => change({ analyzeOnOpen: value })));
  new Setting(options).setName(t('settings.verifyOnHover')).setDesc(t('settings.verifyOnHoverHelp')).addToggle(toggle => toggle.setValue(configuration.verifyOnHover).onChange(value => change({ verifyOnHover: value })));
  new Setting(options).setName(t('settings.autoLinks')).setDesc(t('settings.autoLinksHelp')).addToggle(toggle => toggle.setValue(configuration.autoLinks).onChange(value => change({ autoLinks: value })));

  new Setting(options).setName(t('settings.display')).setHeading();
  new Setting(options).setName(t('settings.linkHints')).setDesc(t('settings.linkHintsHelp')).addDropdown(dropdown => dropdown.addOption('underline', t('settings.hintUnderline')).addOption('marker', t('settings.hintMarker')).addOption('off', t('settings.hintOff')).setValue(configuration.linkHints).onChange(value => change({ linkHints: value as LinkHintStyle })));
  new Setting(options).setName(t('settings.explorerMarkers')).setDesc(t('settings.explorerMarkersHelp')).addToggle(toggle => toggle.setValue(configuration.explorerMarkers).onChange(value => change({ explorerMarkers: value })));

  new Setting(options).setName(t('settings.scope')).setHeading();
  new Setting(options).setName(t('settings.subfolders')).addToggle(toggle => toggle.setValue(configuration.includeSubfolders).onChange(value => change({ includeSubfolders: value })));
  new Setting(options).setName(t('settings.linkScope')).addDropdown(dropdown => dropdown.addOption('vault', t('settings.vault')).addOption('inbox', t('settings.inboxOnly')).setValue(configuration.linkScope).onChange(value => change({ linkScope: value as 'vault' | 'inbox' })));
  pathList(options, app, controller, save, { name: t('settings.excluded'), description: t('settings.excludedHelp'), key: 'excludedPaths', candidates: () => [...controller.allFolders(), ...app.vault.getMarkdownFiles().map(file => file.path)] });
  pathList(options, app, controller, save, { name: t('settings.destinations'), description: t('settings.destinationsHelp'), key: 'excludedDestinations', candidates: () => controller.allFolders().filter(path => path !== controller.settings().inbox) });
  folderRules(options, app, controller, save);
  ignoredTerms(options, controller, save);

  new Setting(options).setName(t('settings.usageHeading')).setHeading();
  const today = controller.usage();
  new Setting(options).setName(t('settings.limit')).setDesc(t('settings.usage', { requests: today.requests, tokens: today.inputTokens, unknown: today.unknownRequests })).addText(input => { input.setValue(String(configuration.dailyRequestLimit)); input.inputEl.type = 'number'; input.inputEl.min = '1'; input.inputEl.max = '10000'; input.inputEl.addEventListener('change', () => change({ dailyRequestLimit: Number(input.getValue()) })); });
  new Setting(options).setName(t('settings.excerpt')).setDesc(t('settings.excerptHelp')).addToggle(toggle => toggle.setValue(configuration.longNoteStrategy === 'excerpt').onChange(value => change({ longNoteStrategy: value ? 'excerpt' : 'full' })));
  new Setting(options).setName(t('settings.profiles')).setDesc(t('settings.profilesHelp')).addToggle(toggle => toggle.setValue(configuration.folderProfilesEnabled).onChange(value => change({ folderProfilesEnabled: value })));

  new Setting(options).setName(t('settings.manage')).setHeading();
  const records = controller.recentMoves(), review = records.filter(record => record.status === 'review' || record.status === 'intent').length;
  new Setting(options).setName(t('organizer.recent')).setDesc(records.length ? t('settings.historyHelp', { count: records.length, review }) : t('settings.historyEmpty')).addButton(control => control.setButtonText(t('settings.historyOpen')).setDisabled(!records.length).onClick(() => new HistoryModal(app, controller).open()));
  new Setting(options).setName(t('settings.restore')).setDesc(t('settings.restoreHelp')).addButton(control => control.setButtonText(t('settings.restoreAction')).onClick(() => { controller.restoreIgnored(); status.textContent = t('settings.restored'); }));
  new Setting(options).setName(t('settings.pause')).setDesc(t('settings.pauseHelp')).addToggle(toggle => toggle.setValue(!controller.enabled()).onChange(paused => controller.setEnabled(!paused)));
}

/** A path setting shown as removable rows with an Add button, instead of a free-form text area. */
function pathList(container: HTMLElement, app: App, controller: OrganizerController, save: Save, options: { name: string; description: string; key: 'excludedPaths' | 'excludedDestinations'; candidates(): string[] }): void {
  const setting = new Setting(container).setName(options.name).setDesc(options.description);
  const list = node(container, 'div', undefined, 'note-organizer-setting-list');
  const render = () => {
    list.replaceChildren();
    for (const path of controller.settings()[options.key]) {
      new Setting(list).setName(path).addExtraButton(control => control.setIcon('x').setTooltip(t('settings.remove')).onClick(() => { void save({ [options.key]: controller.settings()[options.key].filter(item => item !== path) }).then(render).catch(() => undefined); }));
    }
  };
  setting.addButton(control => control.setButtonText(t('settings.add')).onClick(() => new TargetPicker(app, options.candidates().filter(path => !controller.settings()[options.key].includes(path)), path => path, path => {
    void save({ [options.key]: [...controller.settings()[options.key], path] }).then(render).catch(() => undefined);
  }).open()));
  render();
}
function ignoredTerms(container: HTMLElement, controller: OrganizerController, save: Save): void {
  new Setting(container).setName(t('settings.ignoredTerms')).setDesc(t('settings.ignoredTermsHelp'));
  const list = node(container, 'div', undefined, 'note-organizer-setting-list');
  const render = () => {
    list.replaceChildren();
    for (const term of controller.settings().ignoredLinkTerms) new Setting(list).setName(term).addExtraButton(control => control.setIcon('x').setTooltip(t('settings.remove')).onClick(() => { void save({ ignoredLinkTerms: controller.settings().ignoredLinkTerms.filter(item => item !== term) }).then(render).catch(() => undefined); }));
  };
  render();
}
function folderRules(container: HTMLElement, app: App, controller: OrganizerController, save: Save): void {
  const setting = new Setting(container).setName(t('settings.purpose')).setDesc(t('settings.purposeHelp'));
  const list = node(container, 'div', undefined, 'note-organizer-setting-list');
  const render = () => {
    list.replaceChildren();
    for (const rule of [...controller.settings().folderRules].sort((a, b) => a.path.localeCompare(b.path))) {
      new Setting(list).setName(rule.path).setDesc(rule.acceptsNotes ? rule.purpose || t('settings.purposeNone') : t('settings.purposeContainer') + (rule.purpose ? ' · ' + rule.purpose : ''))
        .addExtraButton(control => control.setIcon('pencil').setTooltip(t('settings.edit')).onClick(() => new FolderRuleModal(app, controller, rule.path, render).open()))
        .addExtraButton(control => control.setIcon('x').setTooltip(t('settings.remove')).onClick(() => { void save({ folderRules: controller.settings().folderRules.filter(item => item.path !== rule.path) }).then(render).catch(() => undefined); }));
    }
  };
  setting.addButton(control => control.setButtonText(t('settings.add')).onClick(() => new TargetPicker(app, controller.allFolders().filter(path => path !== controller.settings().inbox), path => path, path => new FolderRuleModal(app, controller, path, render).open()).open()));
  render();
}
class FolderRuleModal extends Modal {
  constructor(app: App, private readonly controller: OrganizerController, private readonly path: string, private readonly saved: () => void = () => undefined) { super(app); }
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
      void this.controller.saveSettings({ folderRules: [...this.controller.settings().folderRules.filter(item => item.path !== this.path), rule] }).then(() => { this.close(); this.saved(); }).catch(error => { status.textContent = errorText(error); save.disabled = false; });
    }, true);
  }
}
