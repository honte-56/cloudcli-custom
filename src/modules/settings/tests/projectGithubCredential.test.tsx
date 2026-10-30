import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@/modules/i18n';
import ProjectGithubCredentialSection from '@/modules/settings/tabs/api-settings/sections/ProjectGithubCredentialSection';

const projects = [{ name: 'one', displayName: 'One' }, { name: 'two', displayName: 'Two' }];
const credentials = [{ id: '11', credential_name: 'Account A', is_active: true, created_at: '' }, { id: '22', credential_name: 'Account B', is_active: true, created_at: '' }];
let bindings: Record<string, number | null>;
let rejectSave = false;
beforeEach(() => {
  bindings = { one: 11, two: 22 }; rejectSave = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const id = url.includes('/one/') ? 'one' : 'two';
    if (init?.method === 'PUT') {
      if (rejectSave) return new Response(JSON.stringify({ error: 'Token unavailable' }), { status: 409 });
      bindings[id] = JSON.parse(String(init.body)).credentialId;
    }
    return new Response(JSON.stringify({ configured: bindings[id] !== null, credentialId: bindings[id], isActive: true }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('loads each project binding and saves its selected token', async () => {
  const view = render(<ProjectGithubCredentialSection projects={projects} credentials={credentials} />);
  await waitFor(() => expect((screen.getByLabelText('GitHub token') as HTMLSelectElement).value).toBe('11'));
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'two' } });
  await waitFor(() => expect((screen.getByLabelText('GitHub token') as HTMLSelectElement).value).toBe('22'));
  fireEvent.change(screen.getByLabelText('GitHub token'), { target: { value: '11' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save binding' }));
  await screen.findByText('Saved. Applies to the next agent run.');
  expect(bindings).toEqual({ one: 11, two: 11 });
  view.unmount();
  render(<ProjectGithubCredentialSection projects={projects} credentials={credentials} />);
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'two' } });
  await waitFor(() => expect((screen.getByLabelText('GitHub token') as HTMLSelectElement).value).toBe('11'));
});

test('clears a binding and displays save failures without pretending success', async () => {
  render(<ProjectGithubCredentialSection projects={projects} credentials={credentials} />);
  await waitFor(() => expect((screen.getByLabelText('GitHub token') as HTMLSelectElement).value).toBe('11'));
  fireEvent.change(screen.getByLabelText('GitHub token'), { target: { value: '' } });
  rejectSave = true;
  fireEvent.click(screen.getByRole('button', { name: 'Save binding' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Saved. Applies to the next agent run.')).toBeNull();
  expect(bindings.one).toBe(11);
  rejectSave = false;
  fireEvent.click(screen.getByRole('button', { name: 'Save binding' }));
  await screen.findByText('Saved. Applies to the next agent run.');
  expect(bindings.one).toBeNull();
});

test('deleted and disabled credentials require a new selection', async () => {
  render(<ProjectGithubCredentialSection projects={projects} credentials={[{ ...credentials[0], is_active: false }]} />);
  await screen.findByText('The bound token is disabled or deleted. Select another token.');
  expect((screen.getByRole('button', { name: 'Save binding' }) as HTMLButtonElement).disabled).toBe(true);
});
