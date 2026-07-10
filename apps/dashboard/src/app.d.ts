import type { RowData } from '@tanstack/table-core';

declare module '@tanstack/table-core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    title?: string;
    width?: string;
    minWidth?: string;
    align?: 'center' | 'left' | 'right';
  }
}

export {};
