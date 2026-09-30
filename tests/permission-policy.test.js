import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveChildFolderAccess, resolveFolderAccess } from '../lib/pikpak-permissions.js'

test('global and folder permissions resolve public, inherited, and locked access', () => {
  const cases = [
    ['locked', [], true],
    ['locked', [{ access: 'inherit' }], true],
    ['locked', [{ access: 'public' }], false],
    ['locked', [{ access: 'locked' }], true],
    ['public', [{ access: 'inherit' }], false],
    ['public', [{ access: 'public' }], false],
    ['public', [{ access: 'locked' }], true],
    ['locked', [{ access: 'locked' }, { access: 'public' }, { access: 'inherit' }], false],
    ['public', [{ access: 'locked' }, { access: 'inherit' }], true],
  ]

  for (const [globalAccess, metadata, expectedLocked] of cases) {
    const resolved = resolveFolderAccess(globalAccess, metadata)
    assert.equal(resolved.requiresAuth, expectedLocked, `${globalAccess} ${JSON.stringify(metadata)}`)
    assert.equal(resolved.effectiveAccess, expectedLocked ? 'locked' : 'public')
  }
})

test('child folders inherit, override to public, or lock independently', () => {
  assert.equal(deriveChildFolderAccess(true, 'inherit').requiresAuth, true)
  assert.equal(deriveChildFolderAccess(true, 'public').requiresAuth, false)
  assert.equal(deriveChildFolderAccess(false, 'locked').requiresAuth, true)
  assert.equal(deriveChildFolderAccess(false, 'inherit').requiresAuth, false)
})
