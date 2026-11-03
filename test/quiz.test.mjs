import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, publicQuestions, MAX_SCORE } from '../src/quiz.mjs';

test('все ответы верные: 10 из 10', () => {
  const r = grade({ q1: 'href', q2: ':hover', q3: 'flex' });
  assert.equal(r.score, 10);
  assert.equal(r.max, MAX_SCORE);
});

test('считаются веса вопросов 3/3/4', () => {
  assert.equal(grade({ q1: 'href' }).score, 3);
  assert.equal(grade({ q2: 'hover' }).score, 3);
  assert.equal(grade({ q3: 'flex' }).score, 4);
});

test('регистр и пробелы не важны', () => {
  assert.equal(grade({ q1: ' HREF ', q2: ' :HOVER', q3: 'Display: Flex' }).score, 10);
});

test('пустые, неверные и посторонние данные дают 0', () => {
  assert.equal(grade({}).score, 0);
  assert.equal(grade(null).score, 0);
  assert.equal(grade({ q1: 'src', q2: ':focus', q3: 'block', q4: 'flex' }).score, 0);
  assert.equal(grade({ q1: ['href'], q2: 5 }).score, 0);
});

test('клиенту не отдаются правильные ответы', () => {
  for (const q of publicQuestions()) assert.equal('accept' in q, false);
});
