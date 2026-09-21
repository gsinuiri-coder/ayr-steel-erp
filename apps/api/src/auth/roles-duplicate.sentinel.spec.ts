import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const SRC_ROOT = join(__dirname, '..');

function listControllerFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...listControllerFiles(abs, rel));
    } else if (entry.endsWith('.controller.ts')) {
      out.push(rel);
    }
  }
  return out;
}

const CONTROLLER_FILES = listControllerFiles(SRC_ROOT);

describe('Centinela de Decoradores Duplicados', () => {
  it.each(CONTROLLER_FILES)('%s: ningun metodo o clase debe tener multiples @Roles', (rel) => {
    const filePath = join(SRC_ROOT, rel);
    const src = readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);

    function checkDecorators(node: ts.Node, name: string) {
      if (!ts.canHaveDecorators(node)) return;
      const decorators = ts.getDecorators(node);
      if (!decorators) return;

      let rolesCount = 0;
      for (const decorator of decorators) {
        if (ts.isCallExpression(decorator.expression)) {
          const exp = decorator.expression.expression;
          if (ts.isIdentifier(exp) && exp.text === 'Roles') {
            rolesCount++;
          }
        }
      }
      if (rolesCount > 1) {
        throw new Error(`Múltiples @Roles en ${name} de ${rel}`);
      }
    }

    function visit(node: ts.Node) {
      if (ts.isClassDeclaration(node)) {
        checkDecorators(node, `la clase ${node.name?.text ?? 'anónima'}`);
      } else if (ts.isMethodDeclaration(node)) {
        const methodName = ts.isIdentifier(node.name) ? node.name.text : 'desconocido';
        checkDecorators(node, `el método ${methodName}`);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  });
});
