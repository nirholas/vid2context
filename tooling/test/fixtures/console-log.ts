export function noisy(value: string) {
  console.log('writes to stdout', value);
  console.info(value);
  console.error('stderr is fine');
  // console.log('a comment is fine');
  return `console.log(${value}) in a template is fine`;
}
