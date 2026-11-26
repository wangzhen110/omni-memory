export function designTestHookMatches(design) {
  return design.includes('`NODE_TEST_CONTEXT` 为 `child` / `child-vN` 时生效')
    && !design.includes('`NODE_TEST_CONTEXT` 存在时生效')
    && design.includes('不是抗篡改安全边界');
}
