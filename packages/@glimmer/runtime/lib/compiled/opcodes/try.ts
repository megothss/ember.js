import { VM_TRY_ENTER_OP } from '@glimmer/constants/lib/syscall-ops';

import { APPEND_OPCODES } from '../../opcodes';
import { ResettableBlockImpl } from '../../vm/element-builder';
import { TryState } from '../../vm/try-state';
import { TryBlockOpcode } from '../../vm/update';

/**
 * Enters a `{{#try}}`. The stack contract, shared with `TryBlock` in the
 * opcode compiler: push `[error, retry, hasError]`, capture them with the body
 * that follows as the closure, and pop them again, so the main VM's stack is
 * unchanged. The body only ever runs in sub-VMs restored from that closure.
 * The boundary's block is linked into the parent's bounds but never pushed on
 * the parent's tree, so nothing here needs popping, on success or on a throw.
 */
APPEND_OPCODES.add(VM_TRY_ENTER_OP, (vm, { op1: end }) => {
  let state = new TryState();
  let { stack } = vm;

  stack.push(state.errorRef);
  stack.push(state.retryRef);
  stack.push(state.hasErrorRef);

  let closure = vm.capture(3);

  stack.pop(3);

  let tree = vm.tree();
  let block = new ResettableBlockImpl(tree.element);
  tree.didAppendBounds(block);

  let opcode = new TryBlockOpcode(closure, vm.context, block, state);

  // Before rendering, so a fallback that throws still leaves the boundary
  // reachable from whatever destroys the parent.
  vm.associateDestroyable(opcode);

  // A cache group of its own, like a component's: an update skips the whole
  // boundary while nothing it read changed. Its `hasError` and failed-attempt
  // tags are consumed into the group, so a retry still reaches it.
  vm.beginCacheGroup('{{#try}}');
  opcode.renderInitial(tree.nextSibling);
  vm.updateWith(opcode);
  vm.commitCacheGroup();

  vm.lowlevel.goto(end);
});
