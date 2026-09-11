export const add = (x, y) =>
  (Number.isInteger(x) && Number.isInteger(y)) ? x + y : { code: 400 };
