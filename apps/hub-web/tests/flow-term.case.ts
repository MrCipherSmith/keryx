import { expect,test } from 'vitest';
import workflowEn from '../src/i18n/workflow.en';import workflowRu from '../src/i18n/workflow.ru';
test('flowWorkspaceDistinction keeps the product term Flow in both locales',()=>{expect(workflowEn.flowWorkspaceDistinction).toContain('lists Flows based');expect(workflowRu.flowWorkspaceDistinction).toContain('находятся Flow на основе');expect(workflowRu.flowWorkspaceDistinction).not.toMatch(/потоки/i);});
