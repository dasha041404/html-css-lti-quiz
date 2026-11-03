import { normalizeAnswer } from './util.mjs';

export const MAX_SCORE = 10;

// Правильные ответы остаются только на сервере.
const QUESTIONS = [
  {
    id: 'q1',
    weight: 3,
    topic: 'HTML',
    snippet: '<a ___="https://example.com">Открыть пример</a>',
    prompt: 'Какой атрибут тега <a> хранит адрес, на который ведёт ссылка?',
    accept: ['href'],
  },
  {
    id: 'q2',
    weight: 3,
    topic: 'CSS',
    snippet: 'a:___ {\n  color: crimson;\n}',
    prompt: 'Какой псевдокласс срабатывает, когда на элемент наведён курсор мыши?',
    accept: [':hover', 'hover', 'a:hover'],
  },
  {
    id: 'q3',
    weight: 4,
    topic: 'CSS',
    snippet: '.row {\n  display: ___;\n  gap: 12px;\n}',
    prompt: 'Какое значение display превращает контейнер во флекс-контейнер?',
    accept: ['flex', 'display:flex'],
  },
];

if (QUESTIONS.reduce((sum, q) => sum + q.weight, 0) !== MAX_SCORE) {
  throw new Error('Сумма весов вопросов должна равняться MAX_SCORE');
}

export function publicQuestions() {
  return QUESTIONS.map(({ id, weight, topic, snippet, prompt }) => ({ id, weight, topic, snippet, prompt }));
}

export function cleanAnswers(answers) {
  const given = answers && typeof answers === 'object' ? answers : {};
  return Object.fromEntries(
    QUESTIONS.map((q) => [q.id, typeof given[q.id] === 'string' ? given[q.id].slice(0, 100) : '']),
  );
}

export function grade(answers) {
  const given = cleanAnswers(answers);
  const details = QUESTIONS.map((q) => ({
    id: q.id,
    weight: q.weight,
    correct: q.accept.map(normalizeAnswer).includes(normalizeAnswer(given[q.id])),
  }));
  const score = details.reduce((sum, d) => sum + (d.correct ? d.weight : 0), 0);
  return { score, max: MAX_SCORE, details };
}
