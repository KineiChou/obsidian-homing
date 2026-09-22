import { App, Modal, Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { OrganizerController } from './types';
import type { OrganizerSettings, FolderRule } from '../settings';
import { messageFor } from '../core/errors';
import { button, details, node } from './dom';
import { CreateInboxModal, TargetPicker } from './target-picker';

export class OrganizerSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly controller: OrganizerController) { super(app, plugin); }
  display(): void { this.containerEl.replaceChildren(); renderSettings(this.containerEl, this.app, this.controller); }
}
export class OrganizerSettingsModal extends Modal {
  constructor(app: App, private readonly controller: OrganizerController) { super(app); }
  onOpen(): void { this.setTitle('笔记整理'); renderSettings(this.contentEl, this.app, this.controller); }
}

export function renderSettings(container: HTMLElement, app: App, controller: OrganizerController): void {
  container.classList.add('note-organizer', 'note-organizer-settings');
  const status = node(container, 'p', '', 'note-organizer-feedback'); status.setAttribute('role', 'status');
  const save = async (patch: Partial<OrganizerSettings>) => { try { await controller.saveSettings({ ...controller.settings(), ...patch }); status.textContent = ''; } catch (error) { status.textContent = messageFor(error); throw error; } };
  const change = (patch: Partial<OrganizerSettings>) => { void save(patch).catch(() => undefined); };
  const inbox = new Setting(container).setName('收件箱').setDesc(controller.settings().inbox || '选择用于收集新笔记的目录。');
  inbox.addButton(control => control.setButtonText('选择目录').onClick(() => new TargetPicker(app, controller.allFolders(), path => path, path => { void save({ inbox: path }).then(() => inbox.setDesc(path)); }).open()));
  inbox.addExtraButton(control => control.setIcon('folder-plus').setTooltip('创建收件箱').onClick(() => new CreateInboxModal(app, async path => { await controller.createInbox(path); inbox.setDesc(path); }).open()));
  const connection = new Setting(container).setName('Jev 连接').setDesc('选择保存的密钥。笔记内容与候选信息会发送到 TypeSafe。');
  new SecretComponent(app, connection.controlEl).setValue(controller.settings().secretName).onChange(name => change({ secretName: name }));
  const enable = new Setting(container).setName(controller.enabled() ? '归档建议已启用' : '启用归档建议').setDesc('先用固定示例检查连接，再分析新进入收件箱的笔记。已有笔记由你手动启动分析。');
  enable.addButton(control => control.setButtonText(controller.enabled() ? '检查连接' : '启用归档建议').setCta().onClick(async () => {
    if (!controller.settings().inbox || !controller.settings().secretName) { status.textContent = '请先选择收件箱和 Jev 密钥。'; return; }
    control.setDisabled(true); status.textContent = '正在检查连接…';
    try { await controller.testConnection(); controller.setEnabled(true); enable.setName('归档建议已启用'); control.setButtonText('检查连接'); status.textContent = '连接正常。'; }
    catch (error) { status.textContent = messageFor(error); }
    finally { control.setDisabled(false); }
  }));
  new Setting(container).setName('自动准备归档建议').setDesc('确认后才移动笔记。关闭后仍可手动分析。').addToggle(toggle => toggle.setValue(controller.enabled() && controller.settings().autoFiling).onChange(value => { change({ autoFiling: value }); if (!value) return; if (controller.settings().inbox && controller.settings().secretName) controller.setEnabled(true); }));
  new Setting(container).setName('写作时准备链接建议').setDesc('发送当前知识库正在编辑的局部文字与候选信息，可能包含未保存内容。建议不会打断写作。').addToggle(toggle => toggle.setValue(controller.settings().autoLinks).onChange(value => change({ autoLinks: value })));
  const advanced = details(container, '范围与用量');
  new Setting(advanced).setName('包含收件箱子目录').addToggle(toggle => toggle.setValue(controller.settings().includeSubfolders).onChange(value => change({ includeSubfolders: value })));
  new Setting(advanced).setName('链接分析范围').addDropdown(dropdown => dropdown.addOption('vault', '当前知识库').addOption('inbox', '仅收件箱').setValue(controller.settings().linkScope).onChange(value => change({ linkScope: value as 'vault' | 'inbox' })));
  new Setting(advanced).setName('完全不处理的目录或文件').setDesc('每行一个完整路径。既不分析其中的笔记，也不将其作为推荐目标。').addTextArea(input => { input.setValue(controller.settings().excludedPaths.join('\n')); input.inputEl.rows = 3; input.inputEl.addEventListener('change', () => change({ excludedPaths: input.getValue().split('\n').map(path => path.trim()).filter(Boolean) })); });
  new Setting(advanced).setName('不作为归档目标的目录').setDesc('每行一个路径，包含其子目录。').addTextArea(input => { input.setValue(controller.settings().excludedDestinations.join('\n')); input.inputEl.rows = 3; input.inputEl.addEventListener('change', () => change({ excludedDestinations: input.getValue().split('\n').map(path => path.trim()).filter(Boolean) })); });
  const usage = controller.usage();
  new Setting(advanced).setName('每日分析请求上限').setDesc(`本机今日已预留 ${usage.requests} 次，其中 ${usage.unknownRequests} 次用量待确认。包含手动分析和重试，请求次数不等于费用。`).addText(input => { input.setValue(String(controller.settings().dailyRequestLimit)); input.inputEl.type = 'number'; input.inputEl.min = '1'; input.inputEl.max = '10000'; input.inputEl.addEventListener('change', () => change({ dailyRequestLimit: Number(input.getValue()) })); });
  new Setting(advanced).setName('目录用途').setDesc('容易混淆时再补充；可将父目录设为只组织子目录。').addButton(control => control.setButtonText('选择目录').onClick(() => new TargetPicker(app, controller.allFolders().filter(path => path !== controller.settings().inbox), path => path, path => new FolderRuleModal(app, controller, path).open()).open()));
  const manage = details(container, '管理');
  new Setting(manage).setName('恢复已忽略的笔记').setDesc('恢复归档列表，按需重新分析。').addButton(control => control.setButtonText('恢复').onClick(() => { controller.restoreIgnored(); status.textContent = '已恢复，可在收件箱中查看。'; }));
  new Setting(manage).setName('暂停本机自动分析').setDesc('暂停后仍可手动分析和确认已有建议。').addToggle(toggle => toggle.setValue(!controller.enabled()).onChange(paused => controller.setEnabled(!paused)));
  node(manage, 'p', `模型：${controller.settings().modelId}`, 'note-organizer-muted');
}

class FolderRuleModal extends Modal {
  constructor(app: App, private readonly controller: OrganizerController, private readonly path: string) { super(app); }
  onOpen(): void {
    this.setTitle(this.path);
    const existing = this.controller.settings().folderRules.find(rule => rule.path === this.path);
    let purpose = existing?.purpose ?? '', acceptsNotes = existing?.acceptsNotes ?? true, subtreeRules = existing?.subtreeRules.join('\n') ?? '';
    new Setting(this.contentEl).setName('适合存放什么').addTextArea(input => input.setValue(purpose).onChange(value => { purpose = value; }));
    new Setting(this.contentEl).setName('允许直接归档到此目录').addToggle(toggle => toggle.setValue(acceptsNotes).onChange(value => { acceptsNotes = value; }));
    new Setting(this.contentEl).setName('对子目录也生效的说明').setDesc('可留空，每行一条。').addTextArea(input => input.setValue(subtreeRules).onChange(value => { subtreeRules = value; }));
    const status = node(this.contentEl, 'p'); status.setAttribute('role', 'status');
    const save = button(this.contentEl, '保存', () => {
      const rule: FolderRule = { path: this.path, purpose, acceptsNotes, subtreeRules: subtreeRules.split('\n').map(value => value.trim()).filter(Boolean) };
      save.disabled = true;
      void this.controller.saveSettings({ ...this.controller.settings(), folderRules: [...this.controller.settings().folderRules.filter(item => item.path !== this.path), rule] }).then(() => this.close()).catch(error => { status.textContent = messageFor(error); save.disabled = false; });
    }, true);
  }
}
