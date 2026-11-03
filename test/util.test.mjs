import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreUrl, isLearner, normalizeAnswer, parseCookies } from '../src/util.mjs';

test('адрес scores вставляется перед query-строкой', () => {
  assert.equal(
    buildScoreUrl('https://m.example/mod/lti/services.php/2/lineitems/7/lineitem?type_id=3'),
    'https://m.example/mod/lti/services.php/2/lineitems/7/lineitem/scores?type_id=3',
  );
});

test('роль студента распознаётся', () => {
  assert.equal(isLearner(['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner']), true);
  assert.equal(isLearner(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor']), false);
  assert.equal(isLearner([]), false);
});

test('normalizeAnswer убирает пробелы, регистр и кавычки', () => {
  assert.equal(normalizeAnswer(' <HREF> '), 'href');
});

test('parseCookies разбирает заголовок', () => {
  assert.deepEqual(parseCookies('a=1; sid=xyz'), { a: '1', sid: 'xyz' });
});
