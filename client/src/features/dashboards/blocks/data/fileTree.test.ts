import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFileTree, folderIds, isPreviewable, pathOf, previewUrlOf } from './fileTree.ts';

const file = (name: string, path: unknown) => ({ name, props: { path } });
const nameOf = (row: { name: string }) => row.name;
const propsOf = (row: { props: Record<string, unknown> }) => row.props;

describe('buildFileTree', () => {
  it('builds folders from props.path, folders first then files by name', () => {
    const tree = buildFileTree(
      [
        file('b.pdf', ['Courses', 'Algebra']),
        file('a.pdf', ['Courses']),
        file('root.png', []),
        file('c.pdf', ['Courses', 'Algebra']),
      ],
      nameOf,
      propsOf,
    );
    assert.deepEqual(
      tree.map((node) => node.name),
      ['Courses', 'root.png'],
    );
    const courses = tree[0];
    assert.ok(courses?.kind === 'folder');
    assert.deepEqual(
      courses.children.map((node) => node.name),
      ['Algebra', 'a.pdf'],
    );
    assert.deepEqual(folderIds(tree), ['/Courses', '/Courses/Algebra']);
  });

  it('a missing or malformed path puts the file at the root', () => {
    assert.deepEqual(pathOf({}), []);
    assert.deepEqual(pathOf({ path: 'x' }), []);
    assert.deepEqual(pathOf({ path: ['a', 3, '', 'b'] }), ['a', 'b']);
  });

  it('two folders with the same name under different parents stay apart', () => {
    const tree = buildFileTree([file('x', ['A', 'S']), file('y', ['B', 'S'])], nameOf, propsOf);
    assert.deepEqual(folderIds(tree), ['/A', '/A/S', '/B', '/B/S']);
  });
});

describe('previews', () => {
  it('only PDFs and images are previewable, from a Drive id or an https URL', () => {
    assert.equal(isPreviewable({ mimeType: 'application/pdf' }), true);
    assert.equal(isPreviewable({ mimeType: 'image/png' }), true);
    assert.equal(isPreviewable({ mimeType: 'text/plain' }), false);
    assert.equal(isPreviewable({}), false);
    assert.equal(
      previewUrlOf({ mimeType: 'application/pdf', driveFileId: 'abc123XYZ_-9' }),
      'https://drive.google.com/file/d/abc123XYZ_-9/preview',
    );
    assert.equal(
      previewUrlOf({ mimeType: 'image/png', previewUrl: 'https://x.example/p.png' }),
      'https://x.example/p.png',
    );
  });

  it('never frames a non-https URL or a malformed Drive id', () => {
    assert.equal(previewUrlOf({ mimeType: 'image/png', previewUrl: 'javascript:alert(1)' }), null);
    assert.equal(previewUrlOf({ mimeType: 'image/png', driveFileId: '../x' }), null);
    assert.equal(previewUrlOf({ mimeType: 'text/plain', driveFileId: 'abc123XYZ_-9' }), null);
  });
});
