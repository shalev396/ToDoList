import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from './AppError.js';
import { CapabilityError } from './CapabilityError.js';
import { ConflictError } from './ConflictError.js';
import { ForbiddenError } from './ForbiddenError.js';
import { MirroredItemError } from './MirroredItemError.js';
import { NotFoundError } from './NotFoundError.js';
import { ProviderComingSoonError } from './ProviderComingSoonError.js';
import { ReadOnlyIntegrationError } from './ReadOnlyIntegrationError.js';
import { ValidationError } from './ValidationError.js';

describe('the error hierarchy', () => {
  it('every error is an AppError, so the error handler answers its status and message', () => {
    const cases: [AppError, number, string | undefined][] = [
      [new NotFoundError(), 404, undefined],
      [new ForbiddenError(), 403, undefined],
      [new ValidationError('title: required'), 400, undefined],
      [new ConflictError(3), 409, undefined],
      [new ReadOnlyIntegrationError('i-1'), 409, 'integration_read_only'],
      [new MirroredItemError('jira', 'https://example.invalid/browse/A-1'), 409, undefined],
      [new CapabilityError('create tasks'), 400, undefined],
      [new ProviderComingSoonError('moodle'), 400, 'provider_coming_soon'],
    ];
    for (const [error, status, code] of cases) {
      assert.ok(error instanceof AppError, error.name);
      assert.ok(error instanceof Error, error.name);
      assert.equal(error.statusCode, status, error.name);
      assert.equal(error.code, code, error.name);
    }
  });

  it('keeps the texts the API has always answered', () => {
    assert.equal(new NotFoundError().message, 'Not found');
    assert.equal(new ForbiddenError().message, 'Forbidden');
    assert.equal(
      new ProviderComingSoonError('moodle').message,
      "moodle is coming soon and can't be connected yet",
    );
    assert.equal(
      new MirroredItemError('jira', 'u').message,
      'This item is mirrored from its source: edit it there',
    );
  });

  it('a role refusal reads "Only an owner" or "Only an editor"', () => {
    assert.equal(ForbiddenError.forRole('owner').message, 'Only an owner can do this');
    assert.equal(ForbiddenError.forRole('editor').message, 'Only an editor can do this');
    assert.equal(ForbiddenError.forRole('viewer').message, 'Only an editor can do this');
    assert.equal(
      ForbiddenError.forRole('owner', 'publish dashboards').message,
      'Only an owner can publish dashboards',
    );
  });

  it('the API’s mirrored-item 409 and the repository’s signal have distinct names', async () => {
    const { MirroredItemError: Stored } = await import('../models/errors.js');
    assert.equal(new MirroredItemError('jira', 'u').name, 'MirroredItemError');
    assert.equal(new Stored('it-1', 'jira', 'u').name, 'StoredMirroredItemError');
  });

  it('the 409 domain errors are not version conflicts (ConflictError answers currentVersion)', () => {
    assert.equal(new ReadOnlyIntegrationError('i-1') instanceof ConflictError, false);
    assert.equal(new MirroredItemError('jira', 'u') instanceof ConflictError, false);
  });

  it('a mirrored item carries where to open it, and the read-only refusal names the integration', () => {
    const mirrored = new MirroredItemError('github', 'https://example.invalid/pull/1');
    assert.deepEqual(mirrored.openIn, {
      provider: 'github',
      url: 'https://example.invalid/pull/1',
    });
    assert.ok(Object.isFrozen(mirrored.openIn));
    assert.equal(new ReadOnlyIntegrationError('i-9').integrationId, 'i-9');
    assert.equal(
      new CapabilityError('list calendars').message,
      "This integration can't list calendars",
    );
  });
});
