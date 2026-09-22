import { Plugin } from 'obsidian';

export default class NoteOrganizerPlugin extends Plugin {
  onload(): void {
    this.addCommand({ id: 'open-review', name: '打开整理建议', callback: () => this.addStatusBarItem().setText('整理') });
  }
}
