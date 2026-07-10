import {
  type RowData,
  type TableOptions,
  type TableOptionsResolved,
  type TableState,
  type Updater,
  createTable
} from '@tanstack/table-core';

/**
 * Creates a reactive TanStack table object for Svelte.
 * @param options Table options to create the table with.
 * @returns A reactive table object.
 * @example
 * ```svelte
 * <script>
 *   const table = createSvelteTable({ ... })
 * </script>
 *
 * <table>
 *   <thead>
 *     {#each table.getHeaderGroups() as headerGroup}
 *       <tr>
 *         {#each headerGroup.headers as header}
 *           <th colspan={header.colSpan}>
 *         	   <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
 *         	 </th>
 *         {/each}
 *       </tr>
 *     {/each}
 *   </thead>
 * 	 <!-- ... -->
 * </table>
 * ```
 */
export function createSvelteTable<TData extends RowData>(options: TableOptions<TData>) {
  const resolvedOptions: TableOptionsResolved<TData> = mergeObjects(
    {
      state: {},
      onStateChange() {},
      renderFallbackValue: null,
      mergeOptions: (defaultOptions: TableOptions<TData>, options: Partial<TableOptions<TData>>) => {
        return mergeObjects(defaultOptions, options);
      }
    },
    options
  );

  const table = createTable(resolvedOptions);
  let state = $state<TableState>(table.initialState);

  function updateOptions() {
    table.setOptions(() => {
      return mergeObjects(resolvedOptions, options, {
        state: mergeObjects(state, options.state || {}),

        onStateChange: (updater: Updater<TableState>) => {
          if (updater instanceof Function) state = updater(state);
          else state = mergeObjects(state, updater);

          options.onStateChange?.(updater);
        }
      });
    });
  }

  updateOptions();

  // Reactive version counter — incremented every time TanStack recomputes.
  // Template expressions that access the table through the Proxy read this signal,
  // which creates a Svelte 5 dependency. Without this, table.getRowModel() etc.
  // are plain method calls with no reactive tracking.
  // _versionRaw is plain (not $state) to avoid reading _version inside the effect,
  // which would cause an infinite loop (read + write in same effect).
  let _versionRaw = 0;
  let _version = $state(0);

  $effect.pre(() => {
    updateOptions();
    _version = ++_versionRaw;
  });

  return new Proxy(table, {
    get(target, prop, receiver) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive touch
      _version;
      return Reflect.get(target, prop, receiver);
    }
  }) as typeof table;
}

type MaybeThunk<T extends object> = T | (() => T | null | undefined);
type Intersection<T extends readonly unknown[]> = (T extends [infer H, ...infer R]
  ? H & Intersection<R>
  : unknown) & {};

/**
 * Lazily merges several objects (or thunks) while preserving
 * getter semantics from every source.
 *
 * Proxy-based to avoid known WebKit recursion issue.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeObjects<Sources extends readonly MaybeThunk<any>[]>(
  ...sources: Sources
): Intersection<{ [K in keyof Sources]: Sources[K] }> {
  const resolve = <T extends object>(src: MaybeThunk<T>): T | undefined =>
    typeof src === 'function' ? (src() ?? undefined) : src;

  const findSourceWithKey = (key: PropertyKey) => {
    for (let i = sources.length - 1; i >= 0; i--) {
      const obj = resolve(sources[i]);
      if (obj && key in obj) return obj;
    }
    return undefined;
  };

  return new Proxy(Object.create(null), {
    get(_, key) {
      const src = findSourceWithKey(key);

      return src?.[key as never];
    },

    has(_, key) {
      return !!findSourceWithKey(key);
    },

    ownKeys(): (string | symbol)[] {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const all = new Set<string | symbol>();
      for (const s of sources) {
        const obj = resolve(s);
        if (obj) {
          for (const k of Reflect.ownKeys(obj) as (string | symbol)[]) {
            all.add(k);
          }
        }
      }
      return [...all];
    },

    getOwnPropertyDescriptor(_, key) {
      const src = findSourceWithKey(key);
      if (!src) return undefined;
      return {
        configurable: true,
        enumerable: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: (src as any)[key],
        writable: true
      };
    }
  }) as Intersection<{ [K in keyof Sources]: Sources[K] }>;
}
