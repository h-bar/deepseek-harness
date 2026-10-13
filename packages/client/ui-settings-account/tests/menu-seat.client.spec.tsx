// @vitest-environment jsdom
/**
 * The account launcher's menu-row seat, exercised through the real registry:
 * a second plugin registers into `settings.launcher.menu.item` and the row has
 * to reach the DOM inside the launcher's own menu. The direct component spec
 * stubs `renderSlot`, so declaration and rendering are only real here.
 */
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { createClientTest, webApp, type TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const it = createClientTest({ roster: webApp }, { mount: true })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Start the assembled client and wait for the account UI to reach the slots. */
async function started(start: () => Promise<TestClient>): Promise<TestClient> {
  const client = await start()
  await vi.waitFor(() => {
    expect(client.container?.querySelector('button[aria-haspopup="menu"]')).toBeTruthy()
  })
  return client
}

// The case boots the whole client composition, so it outgrows vitest's 5s
// default when a lane runs it beside the rest of the client packages.
it('lets another plugin contribute a row into the account menu', { timeout: 30_000 }, async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const client = await started(start)
  // Registering proves the seat exists: `slots.register` throws for an
  // undeclared key ("is not declared (a parent entry's children table must
  // declare it)"), and this registration is what the Saddle plugin does.
  const registered = vi.fn()
  client.ctx.slots.inject('settings.launcher.menu.item', () => client.ctx.slots.register(
    { name: 'settings.launcher.menu.item', id: 'probe.row', order: 100 },
    ({ dismiss }) => (
      <MenuItemButton onSelect={() => { registered(); dismiss() }}>Probe row</MenuItemButton>
    ),
  ))
  const trigger = client.container!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  await act(async () => { fireEvent.click(trigger) })
  const row = document.querySelector('[role="menuitem"]')
  // The row renders inside the launcher's own menu, not somewhere else in the shell.
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent))
    .toEqual(expect.arrayContaining(['Probe row']))
  await act(async () => { fireEvent.click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent === 'Probe row')!) })
  expect(registered).toHaveBeenCalledOnce()
  // The seat's owner share is the launcher's own dismiss: acting closed the menu.
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(row).not.toBeNull()
})
