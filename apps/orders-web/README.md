# orders-web

Internal back-office UI for browsing customer orders. React 18, MobX 6
(legacy decorators), Ant Design, axios, Storybook 8.

## Volumes

- The orders list shows up to 2,000 rows per page.
- The status filter is used constantly by support staff.
- The order drawer opens from the list, one order at a time.

## Layout

- `src/api` - typed axios calls, one module per resource.
- `src/stores` - MobX stores.
- `src/pages` - one folder per page; a page owns its stores.
- `src/components` - presentational components, each with stories.

## Conventions

- UI state that only one component uses lives in `useState`; anything with
  logic or shared between components lives in a MobX store.
- Stores are created once per page and disposed on unmount.
- Stores talk to the server through `src/api`, never components.
- Props interfaces are named `<Component>Props`, without an `I` prefix.
- Every component with visible states (loading, error, empty) has a story
  for each of them.
