import { expect, it } from 'vitest';
import { linkAt } from '../src/linking/link-syntax';

it('finds the wiki or Markdown link around an offset and the text a reader sees', () => {
  const text = 'See [[ML/Transformer|the model]] and [[Attention.md#Heads]] or [notes](ML/Some%20Note.md "title").';
  expect(linkAt(text, text.indexOf('the model'))).toMatchObject({ text: '[[ML/Transformer|the model]]', display: 'the model', target: 'ML/Transformer' });
  expect(linkAt(text, text.indexOf('[[Attention'))).toMatchObject({ display: 'Attention#Heads', target: 'Attention' });
  const markdown = linkAt(text, text.indexOf('notes'))!;
  expect(markdown).toMatchObject({ display: 'notes', target: 'ML/Some Note' });
  expect(text.slice(markdown.from, markdown.to)).toBe(markdown.text);
  expect(linkAt(text, 1)).toBeNull();
});

it('treats both ends of a link as inside it and never unlinks embeds', () => {
  const text = '[[A]] ![[image.png]] ![alt](b.png)';
  expect(linkAt(text, 0)?.display).toBe('A'); expect(linkAt(text, 5)?.display).toBe('A');
  expect(linkAt(text, text.indexOf('image'))).toBeNull(); expect(linkAt(text, text.indexOf('alt'))).toBeNull();
});
