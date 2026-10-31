import { render,screen } from '@testing-library/react';
import { expect,test } from 'vitest';
import { Field,Input,Select } from '../src/components/ui';
test('select label excludes option content and remains an exact accessible name',()=>{
 render(<Field label="Ревизия для Evidence" hint="Выберите проверяемую ревизию"><Select><option>Не выбрано</option><option>Attempt 1</option></Select></Field>);
 const select=screen.getByRole('combobox');expect((select as HTMLSelectElement).labels?.[0]?.textContent).toBe('Ревизия для Evidence');expect(screen.getByLabelText('Ревизия для Evidence',{exact:true})).toBe(select);expect(select).toHaveAccessibleName('Ревизия для Evidence');expect(select).toHaveAccessibleDescription('Выберите проверяемую ревизию');
});
test('explicit control IDs remain associated with their label',()=>{
 render(<Field label="Digest" hint="Exact content digest"><Input id="digest-input"/></Field>);const input=screen.getByLabelText('Digest',{exact:true});expect(input.id).toBe('digest-input');expect(input).toHaveAccessibleDescription('Exact content digest');
});
