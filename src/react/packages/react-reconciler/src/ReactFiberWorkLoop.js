/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {ReactPriorityLevel} from './SchedulerWithReactIntegration';
import type {Interaction} from 'scheduler/src/Tracing';
import type {SuspenseConfig} from './ReactFiberSuspenseConfig';
import type {SuspenseState} from './ReactFiberSuspenseComponent';

import {
  warnAboutDeprecatedLifecycles,
  enableUserTimingAPI,
  enableSuspenseServerRenderer,
  replayFailedUnitOfWorkWithInvokeGuardedCallback,
  enableProfilerTimer,
  enableSchedulerTracing,
  warnAboutUnmockedScheduler,
  flushSuspenseFallbacksInTests,
  disableSchedulerTimeoutBasedOnReactExpirationTime,
} from 'shared/ReactFeatureFlags';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import invariant from 'shared/invariant';
import warning from 'shared/warning';

import {
  scheduleCallback,
  cancelCallback,
  getCurrentPriorityLevel,
  runWithPriority,
  shouldYield,
  requestPaint,
  now,
  NoPriority,
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
  flushSyncCallbackQueue,
  scheduleSyncCallback,
} from './SchedulerWithReactIntegration';

// The scheduler is imported here *only* to detect whether it's been mocked
import * as Scheduler from 'scheduler';

import {__interactionsRef, __subscriberRef} from 'scheduler/tracing';

import {
  prepareForCommit,
  resetAfterCommit,
  scheduleTimeout,
  cancelTimeout,
  noTimeout,
  warnsIfNotActing,
} from './ReactFiberHostConfig';

import {createWorkInProgress, assignFiberPropertiesInDEV} from './ReactFiber';
import {
  isRootSuspendedAtTime,
  markRootSuspendedAtTime,
  markRootFinishedAtTime,
  markRootUpdatedAtTime,
  markRootExpiredAtTime,
} from './ReactFiberRoot';
import {
  NoMode,
  StrictMode,
  ProfileMode,
  BatchedMode,
  ConcurrentMode,
} from './ReactTypeOfMode';
import {
  HostRoot,
  ClassComponent,
  SuspenseComponent,
  SuspenseListComponent,
  FunctionComponent,
  ForwardRef,
  MemoComponent,
  SimpleMemoComponent,
} from 'shared/ReactWorkTags';
import {
  NoEffect,
  PerformedWork,
  Placement,
  Update,
  PlacementAndUpdate,
  Deletion,
  Ref,
  ContentReset,
  Snapshot,
  Callback,
  Passive,
  Incomplete,
  HostEffectMask,
  Hydrating,
  HydratingAndUpdate,
} from 'shared/ReactSideEffectTags';
import {
  NoWork,
  Sync,
  Never,
  msToExpirationTime,
  expirationTimeToMs,
  computeInteractiveExpiration,
  computeAsyncExpiration,
  computeSuspenseExpiration,
  inferPriorityFromExpirationTime,
  LOW_PRIORITY_EXPIRATION,
  Batched,
  Idle,
} from './ReactFiberExpirationTime';
import {beginWork as originalBeginWork} from './ReactFiberBeginWork';
import {completeWork} from './ReactFiberCompleteWork';
import {unwindWork, unwindInterruptedWork} from './ReactFiberUnwindWork';
import {
  throwException,
  createRootErrorUpdate,
  createClassErrorUpdate,
} from './ReactFiberThrow';
import {
  commitBeforeMutationLifeCycles as commitBeforeMutationEffectOnFiber,
  commitLifeCycles as commitLayoutEffectOnFiber,
  commitPassiveHookEffects,
  commitPlacement,
  commitWork,
  commitDeletion,
  commitDetachRef,
  commitAttachRef,
  commitResetTextContent,
} from './ReactFiberCommitWork';
import {enqueueUpdate} from './ReactUpdateQueue';
import {resetContextDependencies} from './ReactFiberNewContext';
import {resetHooks, ContextOnlyDispatcher} from './ReactFiberHooks';
import {createCapturedValue} from './ReactCapturedValue';

import {
  recordCommitTime,
  startProfilerTimer,
  stopProfilerTimerIfRunningAndRecordDelta,
} from './ReactProfilerTimer';

// DEV stuff
import warningWithoutStack from 'shared/warningWithoutStack';
import getComponentName from 'shared/getComponentName';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {
  phase as ReactCurrentDebugFiberPhaseInDEV,
  resetCurrentFiber as resetCurrentDebugFiberInDEV,
  setCurrentFiber as setCurrentDebugFiberInDEV,
  getStackByFiberInDevAndProd,
} from './ReactCurrentFiber';
import {
  recordEffect,
  recordScheduleUpdate,
  startWorkTimer,
  stopWorkTimer,
  stopFailedWorkTimer,
  startWorkLoopTimer,
  stopWorkLoopTimer,
  startCommitTimer,
  stopCommitTimer,
  startCommitSnapshotEffectsTimer,
  stopCommitSnapshotEffectsTimer,
  startCommitHostEffectsTimer,
  stopCommitHostEffectsTimer,
  startCommitLifeCyclesTimer,
  stopCommitLifeCyclesTimer,
} from './ReactDebugFiberPerf';
import {
  invokeGuardedCallback,
  hasCaughtError,
  clearCaughtError,
} from 'shared/ReactErrorUtils';
import {onCommitRoot} from './ReactFiberDevToolsHook';

const ceil = Math.ceil;

const {
  ReactCurrentDispatcher,
  ReactCurrentOwner,
  IsSomeRendererActing,
} = ReactSharedInternals;

type ExecutionContext = number;

const NoContext = /*                    */ 0b000000;
const BatchedContext = /*               */ 0b000001;
const EventContext = /*                 */ 0b000010;
const DiscreteEventContext = /*         */ 0b000100;
const LegacyUnbatchedContext = /*       */ 0b001000;
const RenderContext = /*                */ 0b010000;
const CommitContext = /*                */ 0b100000;

type RootExitStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const RootIncomplete = 0;
const RootFatalErrored = 1;
const RootErrored = 2;
const RootSuspended = 3;
const RootSuspendedWithDelay = 4;
const RootCompleted = 5;
const RootLocked = 6;

export type Thenable = {
  then(resolve: () => mixed, reject?: () => mixed): Thenable | void,

  // Special flag to opt out of tracing interactions across a Suspense boundary.
  __reactDoNotTraceInteractions?: boolean,
};

// Describes where we are in the React execution stack
let executionContext: ExecutionContext = NoContext;
// The root we're working on
let workInProgressRoot: FiberRoot | null = null;
// The fiber we're working on
let workInProgress: Fiber | null = null;
// The expiration time we're rendering
let renderExpirationTime: ExpirationTime = NoWork;
// Whether to root completed, errored, suspended, etc.
let workInProgressRootExitStatus: RootExitStatus = RootIncomplete;
// A fatal error, if one is thrown
let workInProgressRootFatalError: mixed = null;
// Most recent event time among processed updates during this render.
// This is conceptually a time stamp but expressed in terms of an ExpirationTime
// because we deal mostly with expiration times in the hot path, so this avoids
// the conversion happening in the hot path.
let workInProgressRootLatestProcessedExpirationTime: ExpirationTime = Sync;
let workInProgressRootLatestSuspenseTimeout: ExpirationTime = Sync;
let workInProgressRootCanSuspendUsingConfig: null | SuspenseConfig = null;
// The work left over by components that were visited during this render. Only
// includes unprocessed updates, not work in bailed out children.
let workInProgressRootNextUnprocessedUpdateTime: ExpirationTime = NoWork;

// If we're pinged while rendering we don't always restart immediately.
// This flag determines if it might be worthwhile to restart if an opportunity
// happens latere.
let workInProgressRootHasPendingPing: boolean = false;
// The most recent time we committed a fallback. This lets us ensure a train
// model where we don't commit new loading states in too quick succession.
let globalMostRecentFallbackTime: number = 0;
const FALLBACK_THROTTLE_MS: number = 500;

let nextEffect: Fiber | null = null;
let hasUncaughtError = false;
let firstUncaughtError = null;
let legacyErrorBoundariesThatAlreadyFailed: Set<mixed> | null = null;

let rootDoesHavePassiveEffects: boolean = false;
let rootWithPendingPassiveEffects: FiberRoot | null = null;
let pendingPassiveEffectsRenderPriority: ReactPriorityLevel = NoPriority;
let pendingPassiveEffectsExpirationTime: ExpirationTime = NoWork;

let rootsWithPendingDiscreteUpdates: Map<
  FiberRoot,
  ExpirationTime,
> | null = null;

// Use these to prevent an infinite loop of nested updates
const NESTED_UPDATE_LIMIT = 50;
let nestedUpdateCount: number = 0;
let rootWithNestedUpdates: FiberRoot | null = null;

const NESTED_PASSIVE_UPDATE_LIMIT = 50;
let nestedPassiveUpdateCount: number = 0;

let interruptedBy: Fiber | null = null;

// Marks the need to reschedule pending interactions at these expiration times
// during the commit phase. This enables them to be traced across components
// that spawn new work during render. E.g. hidden boundaries, suspended SSR
// hydration or SuspenseList.
let spawnedWorkDuringRender: null | Array<ExpirationTime> = null;

// Expiration times are computed by adding to the current time (the start
// time). However, if two updates are scheduled within the same event, we
// should treat their start times as simultaneous, even if the actual clock
// time has advanced between the first and second call.

// In other words, because expiration times determine how updates are batched,
// we want all updates of like priority that occur within the same event to
// receive the same expiration time. Otherwise we get tearing.
let currentEventTime: ExpirationTime = NoWork;

export function requestCurrentTime() {
  if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
    // We're inside React, so it's fine to read the actual time.
    return msToExpirationTime(now());
  }
  // We're not inside React, so we may be in the middle of a browser event.
  if (currentEventTime !== NoWork) {
    // Use the same start time for all updates until we enter React again.
    return currentEventTime;
  }
  // This is the first update since React yielded. Compute a new start time.
  currentEventTime = msToExpirationTime(now());
  return currentEventTime;
}

export function computeExpirationForFiber(
  currentTime: ExpirationTime,
  fiber: Fiber,
  suspenseConfig: null | SuspenseConfig,
): ExpirationTime {
  const mode = fiber.mode;
  if ((mode & BatchedMode) === NoMode) {
    return Sync;
  }

  const priorityLevel = getCurrentPriorityLevel();
  if ((mode & ConcurrentMode) === NoMode) {
    return priorityLevel === ImmediatePriority ? Sync : Batched;
  }

  if ((executionContext & RenderContext) !== NoContext) {
    // Use whatever time we're already rendering
    // TODO: Should there be a way to opt out, like with `runWithPriority`?
    return renderExpirationTime;
  }

  let expirationTime;
  if (suspenseConfig !== null) {
    // Compute an expiration time based on the Suspense timeout.
    expirationTime = computeSuspenseExpiration(
      currentTime,
      suspenseConfig.timeoutMs | 0 || LOW_PRIORITY_EXPIRATION,
    );
  } else {
    // Compute an expiration time based on the Scheduler priority.
    switch (priorityLevel) {
      case ImmediatePriority:
        expirationTime = Sync;
        break;
      case UserBlockingPriority:
        // TODO: Rename this to computeUserBlockingExpiration
        expirationTime = computeInteractiveExpiration(currentTime);
        break;
      case NormalPriority:
      case LowPriority: // TODO: Handle LowPriority
        // TODO: Rename this to... something better.
        expirationTime = computeAsyncExpiration(currentTime);
        break;
      case IdlePriority:
        expirationTime = Idle;
        break;
      default:
        invariant(false, 'Expected a valid priority level');
    }
  }

  // If we're in the middle of rendering a tree, do not update at the same
  // expiration time that is already rendering.
  // TODO: We shouldn't have to do this if the update is on a different root.
  // Refactor computeExpirationForFiber + scheduleUpdate so we have access to
  // the root when we check for this condition.
  if (workInProgressRoot !== null && expirationTime === renderExpirationTime) {
    // This is a trick to move this update into a separate batch
    expirationTime -= 1;
  }

  return expirationTime;
}

let lastUniqueAsyncExpiration = NoWork;
export function computeUniqueAsyncExpiration(): ExpirationTime {
  const currentTime = requestCurrentTime();
  let result = computeAsyncExpiration(currentTime);
  if (result <= lastUniqueAsyncExpiration) {
    // Since we assume the current time monotonically increases, we only hit
    // this branch when computeUniqueAsyncExpiration is fired multiple times
    // within a 200ms window (or whatever the async bucket size is).
    result -= 1;
  }
  lastUniqueAsyncExpiration = result;
  return result;
}

export function scheduleUpdateOnFiber(
  fiber: Fiber,
  expirationTime: ExpirationTime,
) {
  debugger
  checkForNestedUpdates();
  warnAboutInvalidUpdatesOnClassComponentsInDEV(fiber);
  // 获取 fiber root
  const root = markUpdateTimeFromFiberToRoot(fiber, expirationTime);
  if (root === null) {
    warnAboutUpdateOnUnmountedFiberInDEV(fiber);
    return;
  }

  checkForInterruption(fiber, expirationTime);
  recordScheduleUpdate();

  // TODO: computeExpirationForFiber also reads the priority. Pass the
  // priority as an argument to that function and this one.
  const priorityLevel = getCurrentPriorityLevel();

  if (expirationTime === Sync) {
    if (
      // Check if we're inside unbatchedUpdates
      (executionContext & LegacyUnbatchedContext) !== NoContext &&
      // Check if we're not already rendering
      (executionContext & (RenderContext | CommitContext)) === NoContext
    ) {
      // Register pending interactions on the root to avoid losing traced interaction data.
      schedulePendingInteractions(root, expirationTime);

      // This is a legacy edge case. The initial mount of a ReactDOM.render-ed
      // root inside of batchedUpdates should be synchronous, but layout updates
      // should be deferred until the end of the batch.
      performSyncWorkOnRoot(root);
    } else {
      ensureRootIsScheduled(root);
      schedulePendingInteractions(root, expirationTime);
      if (executionContext === NoContext) {
        // Flush the synchronous work now, unless we're already working or inside
        // a batch. This is intentionally inside scheduleUpdateOnFiber instead of
        // scheduleCallbackForFiber to preserve the ability to schedule a callback
        // without immediately flushing it. We only do this for user-initiated
        // updates, to preserve historical behavior of sync mode.
        flushSyncCallbackQueue();
      }
    }
  } else {
    ensureRootIsScheduled(root);
    schedulePendingInteractions(root, expirationTime);
  }

  if (
    (executionContext & DiscreteEventContext) !== NoContext &&
    // Only updates at user-blocking priority or greater are considered
    // discrete, even inside a discrete event.
    (priorityLevel === UserBlockingPriority ||
      priorityLevel === ImmediatePriority)
  ) {
    // This is the result of a discrete event. Track the lowest priority
    // discrete update per root so we can flush them early, if needed.
    if (rootsWithPendingDiscreteUpdates === null) {
      rootsWithPendingDiscreteUpdates = new Map([[root, expirationTime]]);
    } else {
      const lastDiscreteTime = rootsWithPendingDiscreteUpdates.get(root);
      if (lastDiscreteTime === undefined || lastDiscreteTime > expirationTime) {
        rootsWithPendingDiscreteUpdates.set(root, expirationTime);
      }
    }
  }
}
export const scheduleWork = scheduleUpdateOnFiber;

// This is split into a separate function so we can mark a fiber with pending
// work without treating it as a typical update that originates from an event;
// e.g. retrying a Suspense boundary isn't an update, but it does schedule work
// on a fiber.
function markUpdateTimeFromFiberToRoot(fiber, expirationTime) {
  // Update the source fiber's expiration time
  if (fiber.expirationTime < expirationTime) {
    fiber.expirationTime = expirationTime;
  }
  let alternate = fiber.alternate;
  if (alternate !== null && alternate.expirationTime < expirationTime) {
    alternate.expirationTime = expirationTime;
  }
  // Walk the parent path to the root and update the child expiration time.
  let node = fiber.return;
  let root = null;
  if (node === null && fiber.tag === HostRoot) {
    root = fiber.stateNode;
  } else {
    while (node !== null) {
      alternate = node.alternate;
      if (node.childExpirationTime < expirationTime) {
        node.childExpirationTime = expirationTime;
        if (
          alternate !== null &&
          alternate.childExpirationTime < expirationTime
        ) {
          alternate.childExpirationTime = expirationTime;
        }
      } else if (
        alternate !== null &&
        alternate.childExpirationTime < expirationTime
      ) {
        alternate.childExpirationTime = expirationTime;
      }
      if (node.return === null && node.tag === HostRoot) {
        root = node.stateNode;
        break;
      }
      node = node.return;
    }
  }

  if (root !== null) {
    if (workInProgressRoot === root) {
      // Received an update to a tree that's in the middle of rendering. Mark
      // that's unprocessed work on this root.
      markUnprocessedUpdateTime(expirationTime);

      if (workInProgressRootExitStatus === RootSuspendedWithDelay) {
        // The root already suspended with a delay, which means this render
        // definitely won't finish. Since we have a new update, let's mark it as
        // suspended now, right before marking the incoming update. This has the
        // effect of interrupting the current render and switching to the update.
        // TODO: This happens to work when receiving an update during the render
        // phase, because of the trick inside computeExpirationForFiber to
        // subtract 1 from `renderExpirationTime` to move it into a
        // separate bucket. But we should probably model it with an exception,
        // using the same mechanism we use to force hydration of a subtree.
        // TODO: This does not account for low pri updates that were already
        // scheduled before the root started rendering. Need to track the next
        // pending expiration time (perhaps by backtracking the return path) and
        // then trigger a restart in the `renderDidSuspendDelayIfPossible` path.
        markRootSuspendedAtTime(root, renderExpirationTime);
      }
    }
    // Mark that the root has a pending update.
    markRootUpdatedAtTime(root, expirationTime);
  }

  return root;
}

function getNextRootExpirationTimeToWorkOn(root: FiberRoot): ExpirationTime {
  // Determines the next expiration time that the root should render, taking
  // into account levels that may be suspended, or levels that may have
  // received a ping.

  const lastExpiredTime = root.lastExpiredTime;
  if (lastExpiredTime !== NoWork) {
    return lastExpiredTime;
  }

  // "Pending" refers to any update that hasn't committed yet, including if it
  // suspended. The "suspended" range is therefore a subset.
  const firstPendingTime = root.firstPendingTime;
  if (!isRootSuspendedAtTime(root, firstPendingTime)) {
    // The highest priority pending time is not suspended. Let's work on that.
    return firstPendingTime;
  }

  // If the first pending time is suspended, check if there's a lower priority
  // pending level that we know about. Or check if we received a ping. Work
  // on whichever is higher priority.
  const lastPingedTime = root.lastPingedTime;
  const nextKnownPendingLevel = root.nextKnownPendingLevel;
  return lastPingedTime > nextKnownPendingLevel
    ? lastPingedTime
    : nextKnownPendingLevel;
}

// Use this function to schedule a task for a root. There's only one task per
// root; if a task was already scheduled, we'll check to make sure the
// expiration time of the existing task is the same as the expiration time of
// the next level that the root has work on. This function is called on every
// update, and right before exiting a task.
function ensureRootIsScheduled(root: FiberRoot) {
  const lastExpiredTime = root.lastExpiredTime;
  if (lastExpiredTime !== NoWork) {
    // Special case: Expired work should flush synchronously.
    root.callbackExpirationTime = Sync;
    root.callbackPriority = ImmediatePriority;
    root.callbackNode = scheduleSyncCallback(
      performSyncWorkOnRoot.bind(null, root),
    );
    return;
  }

  const expirationTime = getNextRootExpirationTimeToWorkOn(root);
  const existingCallbackNode = root.callbackNode;
  if (expirationTime === NoWork) {
    // There's nothing to work on.
    if (existingCallbackNode !== null) {
      root.callbackNode = null;
      root.callbackExpirationTime = NoWork;
      root.callbackPriority = NoPriority;
    }
    return;
  }

  // TODO: If this is an update, we already read the current time. Pass the
  // time as an argument.
  const currentTime = requestCurrentTime();
  const priorityLevel = inferPriorityFromExpirationTime(
    currentTime,
    expirationTime,
  );

  // If there's an existing render task, confirm it has the correct priority and
  // expiration time. Otherwise, we'll cancel it and schedule a new one.
  if (existingCallbackNode !== null) {
    const existingCallbackPriority = root.callbackPriority;
    const existingCallbackExpirationTime = root.callbackExpirationTime;
    if (
      // Callback must have the exact same expiration time.
      existingCallbackExpirationTime === expirationTime &&
      // Callback must have greater or equal priority.
      existingCallbackPriority >= priorityLevel
    ) {
      // Existing callback is sufficient.
      return;
    }
    // Need to schedule a new task.
    // TODO: Instead of scheduling a new task, we should be able to change the
    // priority of the existing one.
    cancelCallback(existingCallbackNode);
  }

  root.callbackExpirationTime = expirationTime;
  root.callbackPriority = priorityLevel;

  let callbackNode;
  if (expirationTime === Sync) {
    // Sync React callbacks are scheduled on a special internal queue
    callbackNode = scheduleSyncCallback(performSyncWorkOnRoot.bind(null, root));
  } else if (disableSchedulerTimeoutBasedOnReactExpirationTime) {
    callbackNode = scheduleCallback(
      priorityLevel,
      performConcurrentWorkOnRoot.bind(null, root),
    );
  } else {
    callbackNode = scheduleCallback(
      priorityLevel,
      performConcurrentWorkOnRoot.bind(null, root),
      // Compute a task timeout based on the expiration time. This also affects
      // ordering because tasks are processed in timeout order.
      {timeout: expirationTimeToMs(expirationTime) - now()},
    );
  }

  root.callbackNode = callbackNode;
}

// This is the entry point for every concurrent task, i.e. anything that
// goes through Scheduler.
function performConcurrentWorkOnRoot(root, didTimeout) {
  // Since we know we're in a React event, we can clear the current
  // event time. The next update will compute a new event time.
  currentEventTime = NoWork;

  if (didTimeout) {
    // The render task took too long to complete. Mark the current time as
    // expired to synchronously render all expired work in a single batch.
    const currentTime = requestCurrentTime();
    markRootExpiredAtTime(root, currentTime);
    // This will schedule a synchronous callback.
    ensureRootIsScheduled(root);
    return null;
  }

  // Determine the next expiration time to work on, using the fields stored
  // on the root.
  const expirationTime = getNextRootExpirationTimeToWorkOn(root);
  if (expirationTime !== NoWork) {
    const originalCallbackNode = root.callbackNode;
    invariant(
      (executionContext & (RenderContext | CommitContext)) === NoContext,
      'Should not already be working.',
    );

    flushPassiveEffects();

    // If the root or expiration time have changed, throw out the existing stack
    // and prepare a fresh one. Otherwise we'll continue where we left off.
    if (
      root !== workInProgressRoot ||
      expirationTime !== renderExpirationTime
    ) {
      prepareFreshStack(root, expirationTime);
      startWorkOnPendingInteractions(root, expirationTime);
    }

    // If we have a work-in-progress fiber, it means there's still work to do
    // in this root.
    if (workInProgress !== null) {
      const prevExecutionContext = executionContext;
      executionContext |= RenderContext;
      const prevDispatcher = pushDispatcher(root);
      const prevInteractions = pushInteractions(root);
      startWorkLoopTimer(workInProgress);
      do {
        try {
          workLoopConcurrent();
          break;
        } catch (thrownValue) {
          handleError(root, thrownValue);
        }
      } while (true);
      resetContextDependencies();
      executionContext = prevExecutionContext;
      popDispatcher(prevDispatcher);
      if (enableSchedulerTracing) {
        popInteractions(((prevInteractions: any): Set<Interaction>));
      }

      if (workInProgressRootExitStatus === RootFatalErrored) {
        const fatalError = workInProgressRootFatalError;
        stopInterruptedWorkLoopTimer();
        prepareFreshStack(root, expirationTime);
        markRootSuspendedAtTime(root, expirationTime);
        ensureRootIsScheduled(root);
        throw fatalError;
      }

      if (workInProgress !== null) {
        // There's still work left over. Exit without committing.
        stopInterruptedWorkLoopTimer();
      } else {
        // We now have a consistent tree. The next step is either to commit it,
        // or, if something suspended, wait to commit it after a timeout.
        stopFinishedWorkLoopTimer();

        const finishedWork: Fiber = ((root.finishedWork =
          root.current.alternate): any);
        root.finishedExpirationTime = expirationTime;
        resolveLocksOnRoot(root, expirationTime);
        finishConcurrentRender(
          root,
          finishedWork,
          workInProgressRootExitStatus,
          expirationTime,
        );
      }

      ensureRootIsScheduled(root);
      if (root.callbackNode === originalCallbackNode) {
        // The task node scheduled for this root is the same one that's
        // currently executed. Need to return a continuation.
        return performConcurrentWorkOnRoot.bind(null, root);
      }
    }
  }
  return null;
}

function finishConcurrentRender(
  root,
  finishedWork,
  exitStatus,
  expirationTime,
) {
  // Set this to null to indicate there's no in-progress render.
  workInProgressRoot = null;

  switch (exitStatus) {
    case RootIncomplete:
    case RootFatalErrored: {
      invariant(false, 'Root did not complete. This is a bug in React.');
    }
    // Flow knows about invariant, so it complains if I add a break
    // statement, but eslint doesn't know about invariant, so it complains
    // if I do. eslint-disable-next-line no-fallthrough
    case RootErrored: {
      if (expirationTime !== Idle) {
        // If this was an async render, the error may have happened due to
        // a mutation in a concurrent event. Try rendering one more time,
        // synchronously, to see if the error goes away. If there are
        // lower priority updates, let's include those, too, in case they
        // fix the inconsistency. Render at Idle to include all updates.
        markRootExpiredAtTime(root, Idle);
        break;
      }
      // Commit the root in its errored state.
      commitRoot(root);
      break;
    }
    case RootSuspended: {
      markRootSuspendedAtTime(root, expirationTime);
      const lastSuspendedTime = root.lastSuspendedTime;
      if (expirationTime === lastSuspendedTime) {
        root.nextKnownPendingLevel = getRemainingExpirationTime(finishedWork);
      }
      flushSuspensePriorityWarningInDEV();

      // We have an acceptable loading state. We need to figure out if we
      // should immediately commit it or wait a bit.

      // If we have processed new updates during this render, we may now
      // have a new loading state ready. We want to ensure that we commit
      // that as soon as possible.
      const hasNotProcessedNewUpdates =
        workInProgressRootLatestProcessedExpirationTime === Sync;
      if (
        hasNotProcessedNewUpdates &&
        // do not delay if we're inside an act() scope
        !(
          __DEV__ &&
          flushSuspenseFallbacksInTests &&
          IsThisRendererActing.current
        )
      ) {
        // If we have not processed any new updates during this pass, then
        // this is either a retry of an existing fallback state or a
        // hidden tree. Hidden trees shouldn't be batched with other work
        // and after that's fixed it can only be a retry. We're going to
        // throttle committing retries so that we don't show too many
        // loading states too quickly.
        let msUntilTimeout =
          globalMostRecentFallbackTime + FALLBACK_THROTTLE_MS - now();
        // Don't bother with a very short suspense time.
        if (msUntilTimeout > 10) {
          if (workInProgressRootHasPendingPing) {
            const lastPingedTime = root.lastPingedTime;
            if (lastPingedTime === NoWork || lastPingedTime >= expirationTime) {
              // This render was pinged but we didn't get to restart
              // earlier so try restarting now instead.
              root.lastPingedTime = expirationTime;
              prepareFreshStack(root, expirationTime);
              break;
            }
          }

          const nextTime = getNextRootExpirationTimeToWorkOn(root);
          if (nextTime !== NoWork && nextTime !== expirationTime) {
            // There's additional work on this root.
            break;
          }
          if (
            lastSuspendedTime !== NoWork &&
            lastSuspendedTime !== expirationTime
          ) {
            // We should prefer to render the fallback of at the last
            // suspended level. Ping the last suspended level to try
            // rendering it again.
            root.lastPingedTime = lastSuspendedTime;
            break;
          }

          // The render is suspended, it hasn't timed out, and there's no
          // lower priority work to do. Instead of committing the fallback
          // immediately, wait for more data to arrive.
          root.timeoutHandle = scheduleTimeout(
            commitRoot.bind(null, root),
            msUntilTimeout,
          );
          break;
        }
      }
      // The work expired. Commit immediately.
      commitRoot(root);
      break;
    }
    case RootSuspendedWithDelay: {
      markRootSuspendedAtTime(root, expirationTime);
      const lastSuspendedTime = root.lastSuspendedTime;
      if (expirationTime === lastSuspendedTime) {
        root.nextKnownPendingLevel = getRemainingExpirationTime(finishedWork);
      }
      flushSuspensePriorityWarningInDEV();

      if (
        // do not delay if we're inside an act() scope
        !(
          __DEV__ &&
          flushSuspenseFallbacksInTests &&
          IsThisRendererActing.current
        )
      ) {
        // We're suspended in a state that should be avoided. We'll try to
        // avoid committing it for as long as the timeouts let us.
        if (workInProgressRootHasPendingPing) {
          const lastPingedTime = root.lastPingedTime;
          if (lastPingedTime === NoWork || lastPingedTime >= expirationTime) {
            // This render was pinged but we didn't get to restart earlier
            // so try restarting now instead.
            root.lastPingedTime = expirationTime;
            prepareFreshStack(root, expirationTime);
            break;
          }
        }

        const nextTime = getNextRootExpirationTimeToWorkOn(root);
        if (nextTime !== NoWork && nextTime !== expirationTime) {
          // There's additional work on this root.
          break;
        }
        if (
          lastSuspendedTime !== NoWork &&
          lastSuspendedTime !== expirationTime
        ) {
          // We should prefer to render the fallback of at the last
          // suspended level. Ping the last suspended level to try
          // rendering it again.
          root.lastPingedTime = lastSuspendedTime;
          break;
        }

        let msUntilTimeout;
        if (workInProgressRootLatestSuspenseTimeout !== Sync) {
          // We have processed a suspense config whose expiration time we
          // can use as the timeout.
          msUntilTimeout =
            expirationTimeToMs(workInProgressRootLatestSuspenseTimeout) - now();
        } else if (workInProgressRootLatestProcessedExpirationTime === Sync) {
          // This should never normally happen because only new updates
          // cause delayed states, so we should have processed something.
          // However, this could also happen in an offscreen tree.
          msUntilTimeout = 0;
        } else {
          // If we don't have a suspense config, we're going to use a
          // heuristic to determine how long we can suspend.
          const eventTimeMs: number = inferTimeFromExpirationTime(
            workInProgressRootLatestProcessedExpirationTime,
          );
          const currentTimeMs = now();
          const timeUntilExpirationMs =
            expirationTimeToMs(expirationTime) - currentTimeMs;
          let timeElapsed = currentTimeMs - eventTimeMs;
          if (timeElapsed < 0) {
            // We get this wrong some time since we estimate the time.
            timeElapsed = 0;
          }

          msUntilTimeout = jnd(timeElapsed) - timeElapsed;

          // Clamp the timeout to the expiration time. TODO: Once the
          // event time is exact instead of inferred from expiration time
          // we don't need this.
          if (timeUntilExpirationMs < msUntilTimeout) {
            msUntilTimeout = timeUntilExpirationMs;
          }
        }

        // Don't bother with a very short suspense time.
        if (msUntilTimeout > 10) {
          // The render is suspended, it hasn't timed out, and there's no
          // lower priority work to do. Instead of committing the fallback
          // immediately, wait for more data to arrive.
          root.timeoutHandle = scheduleTimeout(
            commitRoot.bind(null, root),
            msUntilTimeout,
          );
          break;
        }
      }
      // The work expired. Commit immediately.
      commitRoot(root);
      break;
    }
    case RootCompleted: {
      // The work completed. Ready to commit.
      if (
        // do not delay if we're inside an act() scope
        !(
          __DEV__ &&
          flushSuspenseFallbacksInTests &&
          IsThisRendererActing.current
        ) &&
        workInProgressRootLatestProcessedExpirationTime !== Sync &&
        workInProgressRootCanSuspendUsingConfig !== null
      ) {
        // If we have exceeded the minimum loading delay, which probably
        // means we have shown a spinner already, we might have to suspend
        // a bit longer to ensure that the spinner is shown for
        // enough time.
        const msUntilTimeout = computeMsUntilSuspenseLoadingDelay(
          workInProgressRootLatestProcessedExpirationTime,
          expirationTime,
          workInProgressRootCanSuspendUsingConfig,
        );
        if (msUntilTimeout > 10) {
          markRootSuspendedAtTime(root, expirationTime);
          root.timeoutHandle = scheduleTimeout(
            commitRoot.bind(null, root),
            msUntilTimeout,
          );
          break;
        }
      }
      commitRoot(root);
      break;
    }
    case RootLocked: {
      // This root has a lock that prevents it from committing. Exit. If
      // we begin work on the root again, without any intervening updates,
      // it will finish without doing additional work.
      markRootSuspendedAtTime(root, expirationTime);
      break;
    }
    default: {
      invariant(false, 'Unknown root exit status.');
    }
  }
}

// This is the entry point for synchronous tasks that don't go
// through Scheduler
function performSyncWorkOnRoot(root) {
  // Check if there's expired work on this root. Otherwise, render at Sync.
  const lastExpiredTime = root.lastExpiredTime;
  const expirationTime = lastExpiredTime !== NoWork ? lastExpiredTime : Sync;
  if (root.finishedExpirationTime === expirationTime) {
    // There's already a pending commit at this expiration time.
    // TODO: This is poorly factored. This case only exists for the
    // batch.commit() API.
    commitRoot(root);
  } else {
    invariant(
      (executionContext & (RenderContext | CommitContext)) === NoContext,
      'Should not already be working.',
    );

    flushPassiveEffects();

    // If the root or expiration time have changed, throw out the existing stack
    // and prepare a fresh one. Otherwise we'll continue where we left off.
    if (
      root !== workInProgressRoot ||
      expirationTime !== renderExpirationTime
    ) {
      prepareFreshStack(root, expirationTime);
      startWorkOnPendingInteractions(root, expirationTime);
    }

    // If we have a work-in-progress fiber, it means there's still work to do
    // in this root.
    if (workInProgress !== null) {
      const prevExecutionContext = executionContext;
      executionContext |= RenderContext;
      const prevDispatcher = pushDispatcher(root);
      const prevInteractions = pushInteractions(root);
      startWorkLoopTimer(workInProgress);

      do {
        try {
          workLoopSync();
          break;
        } catch (thrownValue) {
          handleError(root, thrownValue);
        }
      } while (true);
      resetContextDependencies();
      executionContext = prevExecutionContext;
      popDispatcher(prevDispatcher);
      if (enableSchedulerTracing) {
        popInteractions(((prevInteractions: any): Set<Interaction>));
      }

      if (workInProgressRootExitStatus === RootFatalErrored) {
        const fatalError = workInProgressRootFatalError;
        stopInterruptedWorkLoopTimer();
        prepareFreshStack(root, expirationTime);
        markRootSuspendedAtTime(root, expirationTime);
        ensureRootIsScheduled(root);
        throw fatalError;
      }

      if (workInProgress !== null) {
        // This is a sync render, so we should have finished the whole tree.
        invariant(
          false,
          'Cannot commit an incomplete root. This error is likely caused by a ' +
            'bug in React. Please file an issue.',
        );
      } else {
        // We now have a consistent tree. Because this is a sync render, we
        // will commit it even if something suspended. The only exception is
        // if the root is locked (using the unstable_createBatch API).
        stopFinishedWorkLoopTimer();
        root.finishedWork = (root.current.alternate: any);
        root.finishedExpirationTime = expirationTime;
        resolveLocksOnRoot(root, expirationTime);
        finishSyncRender(root, workInProgressRootExitStatus, expirationTime);
      }

      // Before exiting, make sure there's a callback scheduled for the next
      // pending level.
      ensureRootIsScheduled(root);
    }
  }

  return null;
}

function finishSyncRender(root, exitStatus, expirationTime) {
  if (exitStatus === RootLocked) {
    // This root has a lock that prevents it from committing. Exit. If we
    // begin work on the root again, without any intervening updates, it
    // will finish without doing additional work.
    markRootSuspendedAtTime(root, expirationTime);
  } else {
    // Set this to null to indicate there's no in-progress render.
    workInProgressRoot = null;

    if (__DEV__) {
      if (
        exitStatus === RootSuspended ||
        exitStatus === RootSuspendedWithDelay
      ) {
        flushSuspensePriorityWarningInDEV();
      }
    }
    commitRoot(root);
  }
}

export function flushRoot(root: FiberRoot, expirationTime: ExpirationTime) {
  if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
    invariant(
      false,
      'work.commit(): Cannot commit while already rendering. This likely ' +
        'means you attempted to commit from inside a lifecycle method.',
    );
  }
  markRootExpiredAtTime(root, expirationTime);
  ensureRootIsScheduled(root);
  flushSyncCallbackQueue();
}

export function flushDiscreteUpdates() {
  // TODO: Should be able to flush inside batchedUpdates, but not inside `act`.
  // However, `act` uses `batchedUpdates`, so there's no way to distinguish
  // those two cases. Need to fix this before exposing flushDiscreteUpdates
  // as a public API.
  if (
    (executionContext & (BatchedContext | RenderContext | CommitContext)) !==
    NoContext
  ) {
    if (__DEV__ && (executionContext & RenderContext) !== NoContext) {
      warning(
        false,
        'unstable_flushDiscreteUpdates: Cannot flush updates when React is ' +
          'already rendering.',
      );
    }
    // We're already rendering, so we can't synchronously flush pending work.
    // This is probably a nested event dispatch triggered by a lifecycle/effect,
    // like `el.focus()`. Exit.
    return;
  }
  flushPendingDiscreteUpdates();
  // If the discrete updates scheduled passive effects, flush them now so that
  // they fire before the next serial event.
  flushPassiveEffects();
}

function resolveLocksOnRoot(root: FiberRoot, expirationTime: ExpirationTime) {
  const firstBatch = root.firstBatch;
  if (
    firstBatch !== null &&
    firstBatch._defer &&
    firstBatch._expirationTime >= expirationTime
  ) {
    scheduleCallback(NormalPriority, () => {
      firstBatch._onComplete();
      return null;
    });
    workInProgressRootExitStatus = RootLocked;
  }
}

export function deferredUpdates<A>(fn: () => A): A {
  // TODO: Remove in favor of Scheduler.next
  return runWithPriority(NormalPriority, fn);
}

export function syncUpdates<A, B, C, R>(
  fn: (A, B, C) => R,
  a: A,
  b: B,
  c: C,
): R {
  return runWithPriority(ImmediatePriority, fn.bind(null, a, b, c));
}

function flushPendingDiscreteUpdates() {
  if (rootsWithPendingDiscreteUpdates !== null) {
    // For each root with pending discrete updates, schedule a callback to
    // immediately flush them.
    const roots = rootsWithPendingDiscreteUpdates;
    rootsWithPendingDiscreteUpdates = null;
    roots.forEach((expirationTime, root) => {
      markRootExpiredAtTime(root, expirationTime);
      ensureRootIsScheduled(root);
    });
    // Now flush the immediate queue.
    flushSyncCallbackQueue();
  }
}

export function batchedUpdates<A, R>(fn: A => R, a: A): R {
  const prevExecutionContext = executionContext;
  executionContext |= BatchedContext;
  try {
    return fn(a);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

export function batchedEventUpdates<A, R>(fn: A => R, a: A): R {
  const prevExecutionContext = executionContext;
  executionContext |= EventContext;
  try {
    return fn(a);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

export function discreteUpdates<A, B, C, R>(
  fn: (A, B, C) => R,
  a: A,
  b: B,
  c: C,
): R {
  const prevExecutionContext = executionContext;
  executionContext |= DiscreteEventContext;
  try {
    // Should this
    return runWithPriority(UserBlockingPriority, fn.bind(null, a, b, c));
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

export function unbatchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  const prevExecutionContext = executionContext;
  executionContext &= ~BatchedContext;
  executionContext |= LegacyUnbatchedContext;
  try {
    return fn(a);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

export function flushSync<A, R>(fn: A => R, a: A): R {
  if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
    invariant(
      false,
      'flushSync was called from inside a lifecycle method. It cannot be ' +
        'called when React is already rendering.',
    );
  }
  const prevExecutionContext = executionContext;
  executionContext |= BatchedContext;
  try {
    return runWithPriority(ImmediatePriority, fn.bind(null, a));
  } finally {
    executionContext = prevExecutionContext;
    // Flush the immediate callbacks that were scheduled during this batch.
    // Note that this will happen even if batchedUpdates is higher up
    // the stack.
    flushSyncCallbackQueue();
  }
}

export function flushControlled(fn: () => mixed): void {
  const prevExecutionContext = executionContext;
  executionContext |= BatchedContext;
  try {
    runWithPriority(ImmediatePriority, fn);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

function prepareFreshStack(root, expirationTime) {
  root.finishedWork = null;
  root.finishedExpirationTime = NoWork;

  const timeoutHandle = root.timeoutHandle;
  if (timeoutHandle !== noTimeout) {
    // The root previous suspended and scheduled a timeout to commit a fallback
    // state. Now that we have additional work, cancel the timeout.
    root.timeoutHandle = noTimeout;
    // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
    cancelTimeout(timeoutHandle);
  }

  if (workInProgress !== null) {
    let interruptedWork = workInProgress.return;
    while (interruptedWork !== null) {
      unwindInterruptedWork(interruptedWork);
      interruptedWork = interruptedWork.return;
    }
  }
  workInProgressRoot = root;
  workInProgress = createWorkInProgress(root.current, null, expirationTime);
  renderExpirationTime = expirationTime;
  workInProgressRootExitStatus = RootIncomplete;
  workInProgressRootFatalError = null;
  workInProgressRootLatestProcessedExpirationTime = Sync;
  workInProgressRootLatestSuspenseTimeout = Sync;
  workInProgressRootCanSuspendUsingConfig = null;
  workInProgressRootNextUnprocessedUpdateTime = NoWork;
  workInProgressRootHasPendingPing = false;

  if (enableSchedulerTracing) {
    spawnedWorkDuringRender = null;
  }

  if (__DEV__) {
    ReactStrictModeWarnings.discardPendingWarnings();
    componentsThatTriggeredHighPriSuspend = null;
  }
}

function handleError(root, thrownValue) {
  do {
    try {
      // Reset module-level state that was set during the render phase.
      resetContextDependencies();
      resetHooks();

      if (workInProgress === null || workInProgress.return === null) {
        // Expected to be working on a non-root fiber. This is a fatal error
        // because there's no ancestor that can handle it; the root is
        // supposed to capture all errors that weren't caught by an error
        // boundary.
        workInProgressRootExitStatus = RootFatalErrored;
        workInProgressRootFatalError = thrownValue;
        return null;
      }

      if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
        // Record the time spent rendering before an error was thrown. This
        // avoids inaccurate Profiler durations in the case of a
        // suspended render.
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, true);
      }

      throwException(
        root,
        workInProgress.return,
        workInProgress,
        thrownValue,
        renderExpirationTime,
      );
      workInProgress = completeUnitOfWork(workInProgress);
    } catch (yetAnotherThrownValue) {
      // Something in the return path also threw.
      thrownValue = yetAnotherThrownValue;
      continue;
    }
    // Return to the normal work loop.
    return;
  } while (true);
}

function pushDispatcher(root) {
  const prevDispatcher = ReactCurrentDispatcher.current;
  ReactCurrentDispatcher.current = ContextOnlyDispatcher;
  if (prevDispatcher === null) {
    // The React isomorphic package does not include a default dispatcher.
    // Instead the first renderer will lazily attach one, in order to give
    // nicer error messages.
    return ContextOnlyDispatcher;
  } else {
    return prevDispatcher;
  }
}

function popDispatcher(prevDispatcher) {
  ReactCurrentDispatcher.current = prevDispatcher;
}

function pushInteractions(root) {
  if (enableSchedulerTracing) {
    const prevInteractions: Set<Interaction> | null = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
    return prevInteractions;
  }
  return null;
}

function popInteractions(prevInteractions) {
  if (enableSchedulerTracing) {
    __interactionsRef.current = prevInteractions;
  }
}

export function markCommitTimeOfFallback() {
  globalMostRecentFallbackTime = now();
}

export function markRenderEventTimeAndConfig(
  expirationTime: ExpirationTime,
  suspenseConfig: null | SuspenseConfig,
): void {
  if (
    expirationTime < workInProgressRootLatestProcessedExpirationTime &&
    expirationTime > Idle
  ) {
    workInProgressRootLatestProcessedExpirationTime = expirationTime;
  }
  if (suspenseConfig !== null) {
    if (
      expirationTime < workInProgressRootLatestSuspenseTimeout &&
      expirationTime > Idle
    ) {
      workInProgressRootLatestSuspenseTimeout = expirationTime;
      // Most of the time we only have one config and getting wrong is not bad.
      workInProgressRootCanSuspendUsingConfig = suspenseConfig;
    }
  }
}

export function markUnprocessedUpdateTime(
  expirationTime: ExpirationTime,
): void {
  if (expirationTime > workInProgressRootNextUnprocessedUpdateTime) {
    workInProgressRootNextUnprocessedUpdateTime = expirationTime;
  }
}

export function renderDidSuspend(): void {
  if (workInProgressRootExitStatus === RootIncomplete) {
    workInProgressRootExitStatus = RootSuspended;
  }
}

export function renderDidSuspendDelayIfPossible(): void {
  if (
    workInProgressRootExitStatus === RootIncomplete ||
    workInProgressRootExitStatus === RootSuspended
  ) {
    workInProgressRootExitStatus = RootSuspendedWithDelay;
  }

  // Check if there's a lower priority update somewhere else in the tree.
  if (
    workInProgressRootNextUnprocessedUpdateTime !== NoWork &&
    workInProgressRoot !== null
  ) {
    // Mark the current render as suspended, and then mark that there's a
    // pending update.
    // TODO: This should immediately interrupt the current render, instead
    // of waiting until the next time we yield.
    markRootSuspendedAtTime(workInProgressRoot, renderExpirationTime);
    markRootUpdatedAtTime(
      workInProgressRoot,
      workInProgressRootNextUnprocessedUpdateTime,
    );
  }
}

export function renderDidError() {
  if (workInProgressRootExitStatus !== RootCompleted) {
    workInProgressRootExitStatus = RootErrored;
  }
}

// Called during render to determine if anything has suspended.
// Returns false if we're not sure.
export function renderHasNotSuspendedYet(): boolean {
  // If something errored or completed, we can't really be sure,
  // so those are false.
  return workInProgressRootExitStatus === RootIncomplete;
}

function inferTimeFromExpirationTime(expirationTime: ExpirationTime): number {
  // We don't know exactly when the update was scheduled, but we can infer an
  // approximate start time from the expiration time.
  const earliestExpirationTimeMs = expirationTimeToMs(expirationTime);
  return earliestExpirationTimeMs - LOW_PRIORITY_EXPIRATION;
}

function inferTimeFromExpirationTimeWithSuspenseConfig(
  expirationTime: ExpirationTime,
  suspenseConfig: SuspenseConfig,
): number {
  // We don't know exactly when the update was scheduled, but we can infer an
  // approximate start time from the expiration time by subtracting the timeout
  // that was added to the event time.
  const earliestExpirationTimeMs = expirationTimeToMs(expirationTime);
  return (
    earliestExpirationTimeMs -
    (suspenseConfig.timeoutMs | 0 || LOW_PRIORITY_EXPIRATION)
  );
}

// The work loop is an extremely hot path. Tell Closure not to inline it.
/** @noinline */
function workLoopSync() {
  // Already timed out, so perform work without checking if we need to yield.
  while (workInProgress !== null) {
    workInProgress = performUnitOfWork(workInProgress);
  }
}

/** @noinline */
function workLoopConcurrent() {
  // Perform work until Scheduler asks us to yield
  while (workInProgress !== null && !shouldYield()) {
    workInProgress = performUnitOfWork(workInProgress);
  }
}

function performUnitOfWork(unitOfWork: Fiber): Fiber | null {
  // The current, flushed, state of this fiber is the alternate. Ideally
  // nothing should rely on this, but relying on it here means that we don't
  // need an additional field on the work in progress.
  const current = unitOfWork.alternate;

  startWorkTimer(unitOfWork);
  setCurrentDebugFiberInDEV(unitOfWork);

  let next;
  if (enableProfilerTimer && (unitOfWork.mode & ProfileMode) !== NoMode) {
    startProfilerTimer(unitOfWork);
    next = beginWork(current, unitOfWork, renderExpirationTime);
    stopProfilerTimerIfRunningAndRecordDelta(unitOfWork, true);
  } else {
    next = beginWork(current, unitOfWork, renderExpirationTime);
  }

  resetCurrentDebugFiberInDEV();
  unitOfWork.memoizedProps = unitOfWork.pendingProps;
  if (next === null) {
    // If this doesn't spawn new work, complete the current work.
    next = completeUnitOfWork(unitOfWork);
  }

  ReactCurrentOwner.current = null;
  return next;
}

function completeUnitOfWork(unitOfWork: Fiber): Fiber | null {
  // Attempt to complete the current unit of work, then move to the next
  // sibling. If there are no more siblings, return to the parent fiber.
  workInProgress = unitOfWork;
  debugger
  do {
    // The current, flushed, state of this fiber is the alternate. Ideally
    // nothing should rely on this, but relying on it here means that we don't
    // need an additional field on the work in progress.
    const current = workInProgress.alternate;
    const returnFiber = workInProgress.return;

    // Check if the work completed or if something threw.
    if ((workInProgress.effectTag & Incomplete) === NoEffect) {
      setCurrentDebugFiberInDEV(workInProgress);
      let next;
      if (
        !enableProfilerTimer ||
        (workInProgress.mode & ProfileMode) === NoMode
      ) {
        next = completeWork(current, workInProgress, renderExpirationTime);
      } else {
        startProfilerTimer(workInProgress);
        next = completeWork(current, workInProgress, renderExpirationTime);
        // Update render duration assuming we didn't error.
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
      }
      stopWorkTimer(workInProgress);
      resetCurrentDebugFiberInDEV();
      resetChildExpirationTime(workInProgress);

      if (next !== null) {
        // Completing this fiber spawned new work. Work on that next.
        return next;
      }

      if (
        returnFiber !== null &&
        // Do not append effects to parents if a sibling failed to complete
        (returnFiber.effectTag & Incomplete) === NoEffect
      ) {
        // Append all the effects of the subtree and this fiber onto the effect
        // list of the parent. The completion order of the children affects the
        // side-effect order.
        if (returnFiber.firstEffect === null) {
          returnFiber.firstEffect = workInProgress.firstEffect;
        }
        if (workInProgress.lastEffect !== null) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress.firstEffect;
          }
          returnFiber.lastEffect = workInProgress.lastEffect;
        }

        // If this fiber had side-effects, we append it AFTER the children's
        // side-effects. We can perform certain side-effects earlier if needed,
        // by doing multiple passes over the effect list. We don't want to
        // schedule our own side-effect on our own list because if end up
        // reusing children we'll schedule this effect onto itself since we're
        // at the end.
        const effectTag = workInProgress.effectTag;

        // Skip both NoWork and PerformedWork tags when creating the effect
        // list. PerformedWork effect is read by React DevTools but shouldn't be
        // committed.
        if (effectTag > PerformedWork) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress;
          } else {
            returnFiber.firstEffect = workInProgress;
          }
          returnFiber.lastEffect = workInProgress;
        }
      }
    } else {
      // This fiber did not complete because something threw. Pop values off
      // the stack without entering the complete phase. If this is a boundary,
      // capture values if possible.
      const next = unwindWork(workInProgress, renderExpirationTime);

      // Because this fiber did not complete, don't reset its expiration time.

      if (
        enableProfilerTimer &&
        (workInProgress.mode & ProfileMode) !== NoMode
      ) {
        // Record the render duration for the fiber that errored.
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);

        // Include the time spent working on failed children before continuing.
        let actualDuration = workInProgress.actualDuration;
        let child = workInProgress.child;
        while (child !== null) {
          actualDuration += child.actualDuration;
          child = child.sibling;
        }
        workInProgress.actualDuration = actualDuration;
      }

      if (next !== null) {
        // If completing this work spawned new work, do that next. We'll come
        // back here again.
        // Since we're restarting, remove anything that is not a host effect
        // from the effect tag.
        // TODO: The name stopFailedWorkTimer is misleading because Suspense
        // also captures and restarts.
        stopFailedWorkTimer(workInProgress);
        next.effectTag &= HostEffectMask;
        return next;
      }
      stopWorkTimer(workInProgress);

      if (returnFiber !== null) {
        // Mark the parent fiber as incomplete and clear its effect list.
        returnFiber.firstEffect = returnFiber.lastEffect = null;
        returnFiber.effectTag |= Incomplete;
      }
    }

    const siblingFiber = workInProgress.sibling;
    if (siblingFiber !== null) {
      // If there is more work to do in this returnFiber, do that next.
      return siblingFiber;
    }
    // Otherwise, return to the parent
    workInProgress = returnFiber;
  } while (workInProgress !== null);

  // We've reached the root.
  if (workInProgressRootExitStatus === RootIncomplete) {
    workInProgressRootExitStatus = RootCompleted;
  }
  return null;
}

function getRemainingExpirationTime(fiber: Fiber) {
  const updateExpirationTime = fiber.expirationTime;
  const childExpirationTime = fiber.childExpirationTime;
  return updateExpirationTime > childExpirationTime
    ? updateExpirationTime
    : childExpirationTime;
}

function resetChildExpirationTime(completedWork: Fiber) {
  if (
    renderExpirationTime !== Never &&
    completedWork.childExpirationTime === Never
  ) {
    // The children of this component are hidden. Don't bubble their
    // expiration times.
    return;
  }

  let newChildExpirationTime = NoWork;

  // Bubble up the earliest expiration time.
  if (enableProfilerTimer && (completedWork.mode & ProfileMode) !== NoMode) {
    // In profiling mode, resetChildExpirationTime is also used to reset
    // profiler durations.
    let actualDuration = completedWork.actualDuration;
    let treeBaseDuration = completedWork.selfBaseDuration;

    // When a fiber is cloned, its actualDuration is reset to 0. This value will
    // only be updated if work is done on the fiber (i.e. it doesn't bailout).
    // When work is done, it should bubble to the parent's actualDuration. If
    // the fiber has not been cloned though, (meaning no work was done), then
    // this value will reflect the amount of time spent working on a previous
    // render. In that case it should not bubble. We determine whether it was
    // cloned by comparing the child pointer.
    const shouldBubbleActualDurations =
      completedWork.alternate === null ||
      completedWork.child !== completedWork.alternate.child;

    let child = completedWork.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (childUpdateExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (childChildExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childChildExpirationTime;
      }
      if (shouldBubbleActualDurations) {
        actualDuration += child.actualDuration;
      }
      treeBaseDuration += child.treeBaseDuration;
      child = child.sibling;
    }
    completedWork.actualDuration = actualDuration;
    completedWork.treeBaseDuration = treeBaseDuration;
  } else {
    let child = completedWork.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (childUpdateExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (childChildExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childChildExpirationTime;
      }
      child = child.sibling;
    }
  }

  completedWork.childExpirationTime = newChildExpirationTime;
}

function commitRoot(root) {
  const renderPriorityLevel = getCurrentPriorityLevel();
  runWithPriority(
    ImmediatePriority,
    commitRootImpl.bind(null, root, renderPriorityLevel),
  );
  return null;
}

function commitRootImpl(root, renderPriorityLevel) {
  flushPassiveEffects();
  flushRenderPhaseStrictModeWarningsInDEV();

  invariant(
    (executionContext & (RenderContext | CommitContext)) === NoContext,
    'Should not already be working.',
  );

  const finishedWork = root.finishedWork;
  const expirationTime = root.finishedExpirationTime;
  if (finishedWork === null) {
    return null;
  }
  root.finishedWork = null;
  root.finishedExpirationTime = NoWork;

  invariant(
    finishedWork !== root.current,
    'Cannot commit the same tree as before. This error is likely caused by ' +
      'a bug in React. Please file an issue.',
  );

  // commitRoot never returns a continuation; it always finishes synchronously.
  // So we can clear these now to allow a new callback to be scheduled.
  root.callbackNode = null;
  root.callbackExpirationTime = NoWork;
  root.callbackPriority = NoPriority;
  root.nextKnownPendingLevel = NoWork;

  startCommitTimer();

  // Update the first and last pending times on this root. The new first
  // pending time is whatever is left on the root fiber.
  const remainingExpirationTimeBeforeCommit = getRemainingExpirationTime(
    finishedWork,
  );
  markRootFinishedAtTime(
    root,
    expirationTime,
    remainingExpirationTimeBeforeCommit,
  );

  if (root === workInProgressRoot) {
    // We can reset these now that they are finished.
    workInProgressRoot = null;
    workInProgress = null;
    renderExpirationTime = NoWork;
  } else {
    // This indicates that the last root we worked on is not the same one that
    // we're committing now. This most commonly happens when a suspended root
    // times out.
  }

  // Get the list of effects.
  let firstEffect;
  if (finishedWork.effectTag > PerformedWork) {
    // A fiber's effect list consists only of its children, not itself. So if
    // the root has an effect, we need to add it to the end of the list. The
    // resulting list is the set that would belong to the root's parent, if it
    // had one; that is, all the effects in the tree including the root.
    if (finishedWork.lastEffect !== null) {
      finishedWork.lastEffect.nextEffect = finishedWork;
      firstEffect = finishedWork.firstEffect;
    } else {
      firstEffect = finishedWork;
    }
  } else {
    // There is no effect on the root.
    firstEffect = finishedWork.firstEffect;
  }

  if (firstEffect !== null) {
    const prevExecutionContext = executionContext;
    executionContext |= CommitContext;
    const prevInteractions = pushInteractions(root);

    // Reset this to null before calling lifecycles
    ReactCurrentOwner.current = null;

    // The commit phase is broken into several sub-phases. We do a separate pass
    // of the effect list for each phase: all mutation effects come before all
    // layout effects, and so on.

    // The first phase a "before mutation" phase. We use this phase to read the
    // state of the host tree right before we mutate it. This is where
    // getSnapshotBeforeUpdate is called.
    startCommitSnapshotEffectsTimer();
    prepareForCommit(root.containerInfo);
    nextEffect = firstEffect;
    do {
      if (__DEV__) {
        invokeGuardedCallback(null, commitBeforeMutationEffects, null);
        if (hasCaughtError()) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          const error = clearCaughtError();
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      } else {
        try {
          commitBeforeMutationEffects();
        } catch (error) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      }
    } while (nextEffect !== null);
    stopCommitSnapshotEffectsTimer();

    if (enableProfilerTimer) {
      // Mark the current commit time to be shared by all Profilers in this
      // batch. This enables them to be grouped later.
      recordCommitTime();
    }

    // The next phase is the mutation phase, where we mutate the host tree.
    startCommitHostEffectsTimer();
    nextEffect = firstEffect;
    do {
      if (__DEV__) {
        invokeGuardedCallback(
          null,
          commitMutationEffects,
          null,
          root,
          renderPriorityLevel,
        );
        if (hasCaughtError()) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          const error = clearCaughtError();
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      } else {
        try {
          commitMutationEffects(root, renderPriorityLevel);
        } catch (error) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      }
    } while (nextEffect !== null);
    stopCommitHostEffectsTimer();
    resetAfterCommit(root.containerInfo);

    // The work-in-progress tree is now the current tree. This must come after
    // the mutation phase, so that the previous tree is still current during
    // componentWillUnmount, but before the layout phase, so that the finished
    // work is current during componentDidMount/Update.
    root.current = finishedWork;

    // The next phase is the layout phase, where we call effects that read
    // the host tree after it's been mutated. The idiomatic use case for this is
    // layout, but class component lifecycles also fire here for legacy reasons.
    startCommitLifeCyclesTimer();
    nextEffect = firstEffect;
    do {
      if (__DEV__) {
        invokeGuardedCallback(
          null,
          commitLayoutEffects,
          null,
          root,
          expirationTime,
        );
        if (hasCaughtError()) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          const error = clearCaughtError();
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      } else {
        try {
          commitLayoutEffects(root, expirationTime);
        } catch (error) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      }
    } while (nextEffect !== null);
    stopCommitLifeCyclesTimer();

    nextEffect = null;

    // Tell Scheduler to yield at the end of the frame, so the browser has an
    // opportunity to paint.
    requestPaint();

    if (enableSchedulerTracing) {
      popInteractions(((prevInteractions: any): Set<Interaction>));
    }
    executionContext = prevExecutionContext;
  } else {
    // No effects.
    root.current = finishedWork;
    // Measure these anyway so the flamegraph explicitly shows that there were
    // no effects.
    // TODO: Maybe there's a better way to report this.
    startCommitSnapshotEffectsTimer();
    stopCommitSnapshotEffectsTimer();
    if (enableProfilerTimer) {
      recordCommitTime();
    }
    startCommitHostEffectsTimer();
    stopCommitHostEffectsTimer();
    startCommitLifeCyclesTimer();
    stopCommitLifeCyclesTimer();
  }

  stopCommitTimer();

  const rootDidHavePassiveEffects = rootDoesHavePassiveEffects;

  if (rootDoesHavePassiveEffects) {
    // This commit has passive effects. Stash a reference to them. But don't
    // schedule a callback until after flushing layout work.
    rootDoesHavePassiveEffects = false;
    rootWithPendingPassiveEffects = root;
    pendingPassiveEffectsExpirationTime = expirationTime;
    pendingPassiveEffectsRenderPriority = renderPriorityLevel;
  } else {
    // We are done with the effect chain at this point so let's clear the
    // nextEffect pointers to assist with GC. If we have passive effects, we'll
    // clear this in flushPassiveEffects.
    nextEffect = firstEffect;
    while (nextEffect !== null) {
      const nextNextEffect = nextEffect.nextEffect;
      nextEffect.nextEffect = null;
      nextEffect = nextNextEffect;
    }
  }

  // Check if there's remaining work on this root
  const remainingExpirationTime = root.firstPendingTime;
  if (remainingExpirationTime !== NoWork) {
    if (enableSchedulerTracing) {
      if (spawnedWorkDuringRender !== null) {
        const expirationTimes = spawnedWorkDuringRender;
        spawnedWorkDuringRender = null;
        for (let i = 0; i < expirationTimes.length; i++) {
          scheduleInteractions(
            root,
            expirationTimes[i],
            root.memoizedInteractions,
          );
        }
      }
      schedulePendingInteractions(root, remainingExpirationTime);
    }
  } else {
    // If there's no remaining work, we can clear the set of already failed
    // error boundaries.
    legacyErrorBoundariesThatAlreadyFailed = null;
  }

  if (enableSchedulerTracing) {
    if (!rootDidHavePassiveEffects) {
      // If there are no passive effects, then we can complete the pending interactions.
      // Otherwise, we'll wait until after the passive effects are flushed.
      // Wait to do this until after remaining work has been scheduled,
      // so that we don't prematurely signal complete for interactions when there's e.g. hidden work.
      finishPendingInteractions(root, expirationTime);
    }
  }

  if (remainingExpirationTime === Sync) {
    // Count the number of times the root synchronously re-renders without
    // finishing. If there are too many, it indicates an infinite update loop.
    if (root === rootWithNestedUpdates) {
      nestedUpdateCount++;
    } else {
      nestedUpdateCount = 0;
      rootWithNestedUpdates = root;
    }
  } else {
    nestedUpdateCount = 0;
  }

  onCommitRoot(finishedWork.stateNode, expirationTime);

  // Always call this before exiting `commitRoot`, to ensure that any
  // additional work on this root is scheduled.
  ensureRootIsScheduled(root);

  if (hasUncaughtError) {
    hasUncaughtError = false;
    const error = firstUncaughtError;
    firstUncaughtError = null;
    throw error;
  }

  if ((executionContext & LegacyUnbatchedContext) !== NoContext) {
    // This is a legacy edge case. We just committed the initial mount of
    // a ReactDOM.render-ed root inside of batchedUpdates. The commit fired
    // synchronously, but layout updates should be deferred until the end
    // of the batch.
    return null;
  }

  // If layout work was scheduled, flush it now.
  flushSyncCallbackQueue();
  return null;
}

function commitBeforeMutationEffects() {
  debugger
  while (nextEffect !== null) {
    const effectTag = nextEffect.effectTag;
    if ((effectTag & Snapshot) !== NoEffect) {
      setCurrentDebugFiberInDEV(nextEffect);
      recordEffect();

      const current = nextEffect.alternate;
      commitBeforeMutationEffectOnFiber(current, nextEffect);

      resetCurrentDebugFiberInDEV();
    }
    if ((effectTag & Passive) !== NoEffect) {
      // If there are passive effects, schedule a callback to flush at
      // the earliest opportunity.
      if (!rootDoesHavePassiveEffects) {
        rootDoesHavePassiveEffects = true;
        scheduleCallback(NormalPriority, () => {
          flushPassiveEffects();
          return null;
        });
      }
    }
    nextEffect = nextEffect.nextEffect;
  }
}

function commitMutationEffects(root: FiberRoot, renderPriorityLevel) {
  debugger
  // TODO: Should probably move the bulk of this function to commitWork.
  while (nextEffect !== null) {
    setCurrentDebugFiberInDEV(nextEffect);

    const effectTag = nextEffect.effectTag;

    if (effectTag & ContentReset) {
      commitResetTextContent(nextEffect);
    }

    if (effectTag & Ref) {
      const current = nextEffect.alternate;
      if (current !== null) {
        commitDetachRef(current);
      }
    }

    // The following switch statement is only concerned about placement,
    // updates, and deletions. To avoid needing to add a case for every possible
    // bitmap value, we remove the secondary effects from the effect tag and
    // switch on that value.
    let primaryEffectTag =
      effectTag & (Placement | Update | Deletion | Hydrating);
    switch (primaryEffectTag) {
      case Placement: {
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is
        // inserted, before any life-cycles like componentDidMount gets called.
        // TODO: findDOMNode doesn't rely on this any more but isMounted does
        // and isMounted is deprecated anyway so we should be able to kill this.
        nextEffect.effectTag &= ~Placement;
        break;
      }
      case PlacementAndUpdate: {
        // Placement
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is
        // inserted, before any life-cycles like componentDidMount gets called.
        nextEffect.effectTag &= ~Placement;

        // Update
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Hydrating: {
        nextEffect.effectTag &= ~Hydrating;
        break;
      }
      case HydratingAndUpdate: {
        nextEffect.effectTag &= ~Hydrating;

        // Update
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Update: {
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Deletion: {
        commitDeletion(root, nextEffect, renderPriorityLevel);
        break;
      }
    }

    // TODO: Only record a mutation effect if primaryEffectTag is non-zero.
    recordEffect();

    resetCurrentDebugFiberInDEV();
    nextEffect = nextEffect.nextEffect;
  }
}

function commitLayoutEffects(
  root: FiberRoot,
  committedExpirationTime: ExpirationTime,
) {
  // TODO: Should probably move the bulk of this function to commitWork.
  debugger
  while (nextEffect !== null) {
    setCurrentDebugFiberInDEV(nextEffect);

    const effectTag = nextEffect.effectTag;

    if (effectTag & (Update | Callback)) {
      recordEffect();
      const current = nextEffect.alternate;
      commitLayoutEffectOnFiber(
        root,
        current,
        nextEffect,
        committedExpirationTime,
      );
    }

    if (effectTag & Ref) {
      recordEffect();
      commitAttachRef(nextEffect);
    }

    resetCurrentDebugFiberInDEV();
    nextEffect = nextEffect.nextEffect;
  }
}

export function flushPassiveEffects() {
  if (pendingPassiveEffectsRenderPriority !== NoPriority) {
    const priorityLevel =
      pendingPassiveEffectsRenderPriority > NormalPriority
        ? NormalPriority
        : pendingPassiveEffectsRenderPriority;
    pendingPassiveEffectsRenderPriority = NoPriority;
    return runWithPriority(priorityLevel, flushPassiveEffectsImpl);
  }
}

function flushPassiveEffectsImpl() {
  if (rootWithPendingPassiveEffects === null) {
    return false;
  }
  const root = rootWithPendingPassiveEffects;
  const expirationTime = pendingPassiveEffectsExpirationTime;
  rootWithPendingPassiveEffects = null;
  pendingPassiveEffectsExpirationTime = NoWork;

  invariant(
    (executionContext & (RenderContext | CommitContext)) === NoContext,
    'Cannot flush passive effects while already rendering.',
  );
  const prevExecutionContext = executionContext;
  executionContext |= CommitContext;
  const prevInteractions = pushInteractions(root);

  // Note: This currently assumes there are no passive effects on the root
  // fiber, because the root is not part of its own effect list. This could
  // change in the future.
  let effect = root.current.firstEffect;
  while (effect !== null) {
    if (__DEV__) {
      setCurrentDebugFiberInDEV(effect);
      invokeGuardedCallback(null, commitPassiveHookEffects, null, effect);
      if (hasCaughtError()) {
        invariant(effect !== null, 'Should be working on an effect.');
        const error = clearCaughtError();
        captureCommitPhaseError(effect, error);
      }
      resetCurrentDebugFiberInDEV();
    } else {
      try {
        commitPassiveHookEffects(effect);
      } catch (error) {
        invariant(effect !== null, 'Should be working on an effect.');
        captureCommitPhaseError(effect, error);
      }
    }
    const nextNextEffect = effect.nextEffect;
    // Remove nextEffect pointer to assist GC
    effect.nextEffect = null;
    effect = nextNextEffect;
  }

  if (enableSchedulerTracing) {
    popInteractions(((prevInteractions: any): Set<Interaction>));
    finishPendingInteractions(root, expirationTime);
  }

  executionContext = prevExecutionContext;

  flushSyncCallbackQueue();

  // If additional passive effects were scheduled, increment a counter. If this
  // exceeds the limit, we'll fire a warning.
  nestedPassiveUpdateCount =
    rootWithPendingPassiveEffects === null ? 0 : nestedPassiveUpdateCount + 1;

  return true;
}

export function isAlreadyFailedLegacyErrorBoundary(instance: mixed): boolean {
  return (
    legacyErrorBoundariesThatAlreadyFailed !== null &&
    legacyErrorBoundariesThatAlreadyFailed.has(instance)
  );
}

export function markLegacyErrorBoundaryAsFailed(instance: mixed) {
  if (legacyErrorBoundariesThatAlreadyFailed === null) {
    legacyErrorBoundariesThatAlreadyFailed = new Set([instance]);
  } else {
    legacyErrorBoundariesThatAlreadyFailed.add(instance);
  }
}

function prepareToThrowUncaughtError(error: mixed) {
  if (!hasUncaughtError) {
    hasUncaughtError = true;
    firstUncaughtError = error;
  }
}
export const onUncaughtError = prepareToThrowUncaughtError;

function captureCommitPhaseErrorOnRoot(
  rootFiber: Fiber,
  sourceFiber: Fiber,
  error: mixed,
) {
  const errorInfo = createCapturedValue(error, sourceFiber);
  const update = createRootErrorUpdate(rootFiber, errorInfo, Sync);
  enqueueUpdate(rootFiber, update);
  const root = markUpdateTimeFromFiberToRoot(rootFiber, Sync);
  if (root !== null) {
    ensureRootIsScheduled(root);
    schedulePendingInteractions(root, Sync);
  }
}

export function captureCommitPhaseError(sourceFiber: Fiber, error: mixed) {
  if (sourceFiber.tag === HostRoot) {
    // Error was thrown at the root. There is no parent, so the root
    // itself should capture it.
    captureCommitPhaseErrorOnRoot(sourceFiber, sourceFiber, error);
    return;
  }

  let fiber = sourceFiber.return;
  while (fiber !== null) {
    if (fiber.tag === HostRoot) {
      captureCommitPhaseErrorOnRoot(fiber, sourceFiber, error);
      return;
    } else if (fiber.tag === ClassComponent) {
      const ctor = fiber.type;
      const instance = fiber.stateNode;
      if (
        typeof ctor.getDerivedStateFromError === 'function' ||
        (typeof instance.componentDidCatch === 'function' &&
          !isAlreadyFailedLegacyErrorBoundary(instance))
      ) {
        const errorInfo = createCapturedValue(error, sourceFiber);
        const update = createClassErrorUpdate(
          fiber,
          errorInfo,
          // TODO: This is always sync
          Sync,
        );
        enqueueUpdate(fiber, update);
        const root = markUpdateTimeFromFiberToRoot(fiber, Sync);
        if (root !== null) {
          ensureRootIsScheduled(root);
          schedulePendingInteractions(root, Sync);
        }
        return;
      }
    }
    fiber = fiber.return;
  }
}

export function pingSuspendedRoot(
  root: FiberRoot,
  thenable: Thenable,
  suspendedTime: ExpirationTime,
) {
  const pingCache = root.pingCache;
  if (pingCache !== null) {
    // The thenable resolved, so we no longer need to memoize, because it will
    // never be thrown again.
    pingCache.delete(thenable);
  }

  if (workInProgressRoot === root && renderExpirationTime === suspendedTime) {
    // Received a ping at the same priority level at which we're currently
    // rendering. We might want to restart this render. This should mirror
    // the logic of whether or not a root suspends once it completes.

    // TODO: If we're rendering sync either due to Sync, Batched or expired,
    // we should probably never restart.

    // If we're suspended with delay, we'll always suspend so we can always
    // restart. If we're suspended without any updates, it might be a retry.
    // If it's early in the retry we can restart. We can't know for sure
    // whether we'll eventually process an update during this render pass,
    // but it's somewhat unlikely that we get to a ping before that, since
    // getting to the root most update is usually very fast.
    if (
      workInProgressRootExitStatus === RootSuspendedWithDelay ||
      (workInProgressRootExitStatus === RootSuspended &&
        workInProgressRootLatestProcessedExpirationTime === Sync &&
        now() - globalMostRecentFallbackTime < FALLBACK_THROTTLE_MS)
    ) {
      // Restart from the root. Don't need to schedule a ping because
      // we're already working on this tree.
      prepareFreshStack(root, renderExpirationTime);
    } else {
      // Even though we can't restart right now, we might get an
      // opportunity later. So we mark this render as having a ping.
      workInProgressRootHasPendingPing = true;
    }
    return;
  }

  if (!isRootSuspendedAtTime(root, suspendedTime)) {
    // The root is no longer suspended at this time.
    return;
  }

  const lastPingedTime = root.lastPingedTime;
  if (lastPingedTime !== NoWork && lastPingedTime < suspendedTime) {
    // There's already a lower priority ping scheduled.
    return;
  }

  // Mark the time at which this ping was scheduled.
  root.lastPingedTime = suspendedTime;

  if (root.finishedExpirationTime === suspendedTime) {
    // If there's a pending fallback waiting to commit, throw it away.
    root.finishedExpirationTime = NoWork;
    root.finishedWork = null;
  }

  ensureRootIsScheduled(root);
  schedulePendingInteractions(root, suspendedTime);
}

function retryTimedOutBoundary(
  boundaryFiber: Fiber,
  retryTime: ExpirationTime,
) {
  // The boundary fiber (a Suspense component or SuspenseList component)
  // previously was rendered in its fallback state. One of the promises that
  // suspended it has resolved, which means at least part of the tree was
  // likely unblocked. Try rendering again, at a new expiration time.
  if (retryTime === Never) {
    const suspenseConfig = null; // Retries don't carry over the already committed update.
    const currentTime = requestCurrentTime();
    retryTime = computeExpirationForFiber(
      currentTime,
      boundaryFiber,
      suspenseConfig,
    );
  }
  // TODO: Special case idle priority?
  const root = markUpdateTimeFromFiberToRoot(boundaryFiber, retryTime);
  if (root !== null) {
    ensureRootIsScheduled(root);
    schedulePendingInteractions(root, retryTime);
  }
}

export function retryDehydratedSuspenseBoundary(boundaryFiber: Fiber) {
  const suspenseState: null | SuspenseState = boundaryFiber.memoizedState;
  let retryTime = Never;
  if (suspenseState !== null) {
    retryTime = suspenseState.retryTime;
  }
  retryTimedOutBoundary(boundaryFiber, retryTime);
}

export function resolveRetryThenable(boundaryFiber: Fiber, thenable: Thenable) {
  let retryTime = Never; // Default
  let retryCache: WeakSet<Thenable> | Set<Thenable> | null;
  if (enableSuspenseServerRenderer) {
    switch (boundaryFiber.tag) {
      case SuspenseComponent:
        retryCache = boundaryFiber.stateNode;
        const suspenseState: null | SuspenseState = boundaryFiber.memoizedState;
        if (suspenseState !== null) {
          retryTime = suspenseState.retryTime;
        }
        break;
      case SuspenseListComponent:
        retryCache = boundaryFiber.stateNode;
        break;
      default:
        invariant(
          false,
          'Pinged unknown suspense boundary type. ' +
            'This is probably a bug in React.',
        );
    }
  } else {
    retryCache = boundaryFiber.stateNode;
  }

  if (retryCache !== null) {
    // The thenable resolved, so we no longer need to memoize, because it will
    // never be thrown again.
    retryCache.delete(thenable);
  }

  retryTimedOutBoundary(boundaryFiber, retryTime);
}

// Computes the next Just Noticeable Difference (JND) boundary.
// The theory is that a person can't tell the difference between small differences in time.
// Therefore, if we wait a bit longer than necessary that won't translate to a noticeable
// difference in the experience. However, waiting for longer might mean that we can avoid
// showing an intermediate loading state. The longer we have already waited, the harder it
// is to tell small differences in time. Therefore, the longer we've already waited,
// the longer we can wait additionally. At some point we have to give up though.
// We pick a train model where the next boundary commits at a consistent schedule.
// These particular numbers are vague estimates. We expect to adjust them based on research.
function jnd(timeElapsed: number) {
  return timeElapsed < 120
    ? 120
    : timeElapsed < 480
      ? 480
      : timeElapsed < 1080
        ? 1080
        : timeElapsed < 1920
          ? 1920
          : timeElapsed < 3000
            ? 3000
            : timeElapsed < 4320
              ? 4320
              : ceil(timeElapsed / 1960) * 1960;
}

function computeMsUntilSuspenseLoadingDelay(
  mostRecentEventTime: ExpirationTime,
  committedExpirationTime: ExpirationTime,
  suspenseConfig: SuspenseConfig,
) {
  const busyMinDurationMs = (suspenseConfig.busyMinDurationMs: any) | 0;
  if (busyMinDurationMs <= 0) {
    return 0;
  }
  const busyDelayMs = (suspenseConfig.busyDelayMs: any) | 0;

  // Compute the time until this render pass would expire.
  const currentTimeMs: number = now();
  const eventTimeMs: number = inferTimeFromExpirationTimeWithSuspenseConfig(
    mostRecentEventTime,
    suspenseConfig,
  );
  const timeElapsed = currentTimeMs - eventTimeMs;
  if (timeElapsed <= busyDelayMs) {
    // If we haven't yet waited longer than the initial delay, we don't
    // have to wait any additional time.
    return 0;
  }
  const msUntilTimeout = busyDelayMs + busyMinDurationMs - timeElapsed;
  // This is the value that is passed to `setTimeout`.
  return msUntilTimeout;
}

function checkForNestedUpdates() {
  if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
    nestedUpdateCount = 0;
    rootWithNestedUpdates = null;
    invariant(
      false,
      'Maximum update depth exceeded. This can happen when a component ' +
        'repeatedly calls setState inside componentWillUpdate or ' +
        'componentDidUpdate. React limits the number of nested updates to ' +
        'prevent infinite loops.',
    );
  }

  if (__DEV__) {
    if (nestedPassiveUpdateCount > NESTED_PASSIVE_UPDATE_LIMIT) {
      nestedPassiveUpdateCount = 0;
      warning(
        false,
        'Maximum update depth exceeded. This can happen when a component ' +
          "calls setState inside useEffect, but useEffect either doesn't " +
          'have a dependency array, or one of the dependencies changes on ' +
          'every render.',
      );
    }
  }
}

function flushRenderPhaseStrictModeWarningsInDEV() {
  if (__DEV__) {
    ReactStrictModeWarnings.flushLegacyContextWarning();

    if (warnAboutDeprecatedLifecycles) {
      ReactStrictModeWarnings.flushPendingUnsafeLifecycleWarnings();
    }
  }
}

function stopFinishedWorkLoopTimer() {
  const didCompleteRoot = true;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  interruptedBy = null;
}

function stopInterruptedWorkLoopTimer() {
  // TODO: Track which fiber caused the interruption.
  const didCompleteRoot = false;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  interruptedBy = null;
}

function checkForInterruption(
  fiberThatReceivedUpdate: Fiber,
  updateExpirationTime: ExpirationTime,
) {
  if (
    enableUserTimingAPI &&
    workInProgressRoot !== null &&
    updateExpirationTime > renderExpirationTime
  ) {
    interruptedBy = fiberThatReceivedUpdate;
  }
}

let didWarnStateUpdateForUnmountedComponent: Set<string> | null = null;
function warnAboutUpdateOnUnmountedFiberInDEV(fiber) {
  if (__DEV__) {
    const tag = fiber.tag;
    if (
      tag !== HostRoot &&
      tag !== ClassComponent &&
      tag !== FunctionComponent &&
      tag !== ForwardRef &&
      tag !== MemoComponent &&
      tag !== SimpleMemoComponent
    ) {
      // Only warn for user-defined components, not internal ones like Suspense.
      return;
    }
    // We show the whole stack but dedupe on the top component's name because
    // the problematic code almost always lies inside that component.
    const componentName = getComponentName(fiber.type) || 'ReactComponent';
    if (didWarnStateUpdateForUnmountedComponent !== null) {
      if (didWarnStateUpdateForUnmountedComponent.has(componentName)) {
        return;
      }
      didWarnStateUpdateForUnmountedComponent.add(componentName);
    } else {
      didWarnStateUpdateForUnmountedComponent = new Set([componentName]);
    }
    warningWithoutStack(
      false,
      "Can't perform a React state update on an unmounted component. This " +
        'is a no-op, but it indicates a memory leak in your application. To ' +
        'fix, cancel all subscriptions and asynchronous tasks in %s.%s',
      tag === ClassComponent
        ? 'the componentWillUnmount method'
        : 'a useEffect cleanup function',
      getStackByFiberInDevAndProd(fiber),
    );
  }
}

let beginWork;
if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
  let dummyFiber = null;
  beginWork = (current, unitOfWork, expirationTime) => {
    // If a component throws an error, we replay it again in a synchronously
    // dispatched event, so that the debugger will treat it as an uncaught
    // error See ReactErrorUtils for more information.

    // Before entering the begin phase, copy the work-in-progress onto a dummy
    // fiber. If beginWork throws, we'll use this to reset the state.
    const originalWorkInProgressCopy = assignFiberPropertiesInDEV(
      dummyFiber,
      unitOfWork,
    );
    try {
      return originalBeginWork(current, unitOfWork, expirationTime);
    } catch (originalError) {
      if (
        originalError !== null &&
        typeof originalError === 'object' &&
        typeof originalError.then === 'function'
      ) {
        // Don't replay promises. Treat everything else like an error.
        throw originalError;
      }

      // Keep this code in sync with renderRoot; any changes here must have
      // corresponding changes there.
      resetContextDependencies();
      resetHooks();

      // Unwind the failed stack frame
      unwindInterruptedWork(unitOfWork);

      // Restore the original properties of the fiber.
      assignFiberPropertiesInDEV(unitOfWork, originalWorkInProgressCopy);

      if (enableProfilerTimer && unitOfWork.mode & ProfileMode) {
        // Reset the profiler timer.
        startProfilerTimer(unitOfWork);
      }

      // Run beginWork again.
      invokeGuardedCallback(
        null,
        originalBeginWork,
        null,
        current,
        unitOfWork,
        expirationTime,
      );

      if (hasCaughtError()) {
        const replayError = clearCaughtError();
        // `invokeGuardedCallback` sometimes sets an expando `_suppressLogging`.
        // Rethrow this error instead of the original one.
        throw replayError;
      } else {
        // This branch is reachable if the render phase is impure.
        throw originalError;
      }
    }
  };
} else {
  beginWork = originalBeginWork;
}

let didWarnAboutUpdateInRender = false;
let didWarnAboutUpdateInGetChildContext = false;
function warnAboutInvalidUpdatesOnClassComponentsInDEV(fiber) {
  if (__DEV__) {
    if (fiber.tag === ClassComponent) {
      switch (ReactCurrentDebugFiberPhaseInDEV) {
        case 'getChildContext':
          if (didWarnAboutUpdateInGetChildContext) {
            return;
          }
          warningWithoutStack(
            false,
            'setState(...): Cannot call setState() inside getChildContext()',
          );
          didWarnAboutUpdateInGetChildContext = true;
          break;
        case 'render':
          if (didWarnAboutUpdateInRender) {
            return;
          }
          warningWithoutStack(
            false,
            'Cannot update during an existing state transition (such as ' +
              'within `render`). Render methods should be a pure function of ' +
              'props and state.',
          );
          didWarnAboutUpdateInRender = true;
          break;
      }
    }
  }
}

// a 'shared' variable that changes when act() opens/closes in tests.
export const IsThisRendererActing = {current: (false: boolean)};

export function warnIfNotScopedWithMatchingAct(fiber: Fiber): void {
  if (__DEV__) {
    if (
      warnsIfNotActing === true &&
      IsSomeRendererActing.current === true &&
      IsThisRendererActing.current !== true
    ) {
      warningWithoutStack(
        false,
        "It looks like you're using the wrong act() around your test interactions.\n" +
          'Be sure to use the matching version of act() corresponding to your renderer:\n\n' +
          '// for react-dom:\n' +
          "import {act} from 'react-dom/test-utils';\n" +
          '// ...\n' +
          'act(() => ...);\n\n' +
          '// for react-test-renderer:\n' +
          "import TestRenderer from 'react-test-renderer';\n" +
          'const {act} = TestRenderer;\n' +
          '// ...\n' +
          'act(() => ...);' +
          '%s',
        getStackByFiberInDevAndProd(fiber),
      );
    }
  }
}

export function warnIfNotCurrentlyActingEffectsInDEV(fiber: Fiber): void {
  if (__DEV__) {
    if (
      warnsIfNotActing === true &&
      (fiber.mode & StrictMode) !== NoMode &&
      IsSomeRendererActing.current === false &&
      IsThisRendererActing.current === false
    ) {
      warningWithoutStack(
        false,
        'An update to %s ran an effect, but was not wrapped in act(...).\n\n' +
          'When testing, code that causes React state updates should be ' +
          'wrapped into act(...):\n\n' +
          'act(() => {\n' +
          '  /* fire events that update state */\n' +
          '});\n' +
          '/* assert on the output */\n\n' +
          "This ensures that you're testing the behavior the user would see " +
          'in the browser.' +
          ' Learn more at https://fb.me/react-wrap-tests-with-act' +
          '%s',
        getComponentName(fiber.type),
        getStackByFiberInDevAndProd(fiber),
      );
    }
  }
}

function warnIfNotCurrentlyActingUpdatesInDEV(fiber: Fiber): void {
  if (__DEV__) {
    if (
      warnsIfNotActing === true &&
      executionContext === NoContext &&
      IsSomeRendererActing.current === false &&
      IsThisRendererActing.current === false
    ) {
      warningWithoutStack(
        false,
        'An update to %s inside a test was not wrapped in act(...).\n\n' +
          'When testing, code that causes React state updates should be ' +
          'wrapped into act(...):\n\n' +
          'act(() => {\n' +
          '  /* fire events that update state */\n' +
          '});\n' +
          '/* assert on the output */\n\n' +
          "This ensures that you're testing the behavior the user would see " +
          'in the browser.' +
          ' Learn more at https://fb.me/react-wrap-tests-with-act' +
          '%s',
        getComponentName(fiber.type),
        getStackByFiberInDevAndProd(fiber),
      );
    }
  }
}

export const warnIfNotCurrentlyActingUpdatesInDev = warnIfNotCurrentlyActingUpdatesInDEV;

// In tests, we want to enforce a mocked scheduler.
let didWarnAboutUnmockedScheduler = false;
// TODO Before we release concurrent mode, revisit this and decide whether a mocked
// scheduler is the actual recommendation. The alternative could be a testing build,
// a new lib, or whatever; we dunno just yet. This message is for early adopters
// to get their tests right.

export function warnIfUnmockedScheduler(fiber: Fiber) {
  if (__DEV__) {
    if (
      didWarnAboutUnmockedScheduler === false &&
      Scheduler.unstable_flushAllWithoutAsserting === undefined
    ) {
      if (fiber.mode & BatchedMode || fiber.mode & ConcurrentMode) {
        didWarnAboutUnmockedScheduler = true;
        warningWithoutStack(
          false,
          'In Concurrent or Sync modes, the "scheduler" module needs to be mocked ' +
            'to guarantee consistent behaviour across tests and browsers. ' +
            'For example, with jest: \n' +
            "jest.mock('scheduler', () => require('scheduler/unstable_mock'));\n\n" +
            'For more info, visit https://fb.me/react-mock-scheduler',
        );
      } else if (warnAboutUnmockedScheduler === true) {
        didWarnAboutUnmockedScheduler = true;
        warningWithoutStack(
          false,
          'Starting from React v17, the "scheduler" module will need to be mocked ' +
            'to guarantee consistent behaviour across tests and browsers. ' +
            'For example, with jest: \n' +
            "jest.mock('scheduler', () => require('scheduler/unstable_mock'));\n\n" +
            'For more info, visit https://fb.me/react-mock-scheduler',
        );
      }
    }
  }
}

let componentsThatTriggeredHighPriSuspend = null;
export function checkForWrongSuspensePriorityInDEV(sourceFiber: Fiber) {
  if (__DEV__) {
    const currentPriorityLevel = getCurrentPriorityLevel();
    if (
      (sourceFiber.mode & ConcurrentMode) !== NoEffect &&
      (currentPriorityLevel === UserBlockingPriority ||
        currentPriorityLevel === ImmediatePriority)
    ) {
      let workInProgressNode = sourceFiber;
      while (workInProgressNode !== null) {
        // Add the component that triggered the suspense
        const current = workInProgressNode.alternate;
        if (current !== null) {
          // TODO: warn component that triggers the high priority
          // suspend is the HostRoot
          switch (workInProgressNode.tag) {
            case ClassComponent:
              // Loop through the component's update queue and see whether the component
              // has triggered any high priority updates
              const updateQueue = current.updateQueue;
              if (updateQueue !== null) {
                let update = updateQueue.firstUpdate;
                while (update !== null) {
                  const priorityLevel = update.priority;
                  if (
                    priorityLevel === UserBlockingPriority ||
                    priorityLevel === ImmediatePriority
                  ) {
                    if (componentsThatTriggeredHighPriSuspend === null) {
                      componentsThatTriggeredHighPriSuspend = new Set([
                        getComponentName(workInProgressNode.type),
                      ]);
                    } else {
                      componentsThatTriggeredHighPriSuspend.add(
                        getComponentName(workInProgressNode.type),
                      );
                    }
                    break;
                  }
                  update = update.next;
                }
              }
              break;
            case FunctionComponent:
            case ForwardRef:
            case SimpleMemoComponent:
              if (
                workInProgressNode.memoizedState !== null &&
                workInProgressNode.memoizedState.baseUpdate !== null
              ) {
                let update = workInProgressNode.memoizedState.baseUpdate;
                // Loop through the functional component's memoized state to see whether
                // the component has triggered any high pri updates
                while (update !== null) {
                  const priority = update.priority;
                  if (
                    priority === UserBlockingPriority ||
                    priority === ImmediatePriority
                  ) {
                    if (componentsThatTriggeredHighPriSuspend === null) {
                      componentsThatTriggeredHighPriSuspend = new Set([
                        getComponentName(workInProgressNode.type),
                      ]);
                    } else {
                      componentsThatTriggeredHighPriSuspend.add(
                        getComponentName(workInProgressNode.type),
                      );
                    }
                    break;
                  }
                  if (
                    update.next === workInProgressNode.memoizedState.baseUpdate
                  ) {
                    break;
                  }
                  update = update.next;
                }
              }
              break;
            default:
              break;
          }
        }
        workInProgressNode = workInProgressNode.return;
      }
    }
  }
}

function flushSuspensePriorityWarningInDEV() {
  if (__DEV__) {
    if (componentsThatTriggeredHighPriSuspend !== null) {
      const componentNames = [];
      componentsThatTriggeredHighPriSuspend.forEach(name =>
        componentNames.push(name),
      );
      componentsThatTriggeredHighPriSuspend = null;

      if (componentNames.length > 0) {
        warningWithoutStack(
          false,
          '%s triggered a user-blocking update that suspended.' +
            '\n\n' +
            'The fix is to split the update into multiple parts: a user-blocking ' +
            'update to provide immediate feedback, and another update that ' +
            'triggers the bulk of the changes.' +
            '\n\n' +
            'Refer to the documentation for useSuspenseTransition to learn how ' +
            'to implement this pattern.',
          // TODO: Add link to React docs with more information, once it exists
          componentNames.sort().join(', '),
        );
      }
    }
  }
}

function computeThreadID(root, expirationTime) {
  // Interaction threads are unique per root and expiration time.
  return expirationTime * 1000 + root.interactionThreadID;
}

export function markSpawnedWork(expirationTime: ExpirationTime) {
  if (!enableSchedulerTracing) {
    return;
  }
  if (spawnedWorkDuringRender === null) {
    spawnedWorkDuringRender = [expirationTime];
  } else {
    spawnedWorkDuringRender.push(expirationTime);
  }
}

function scheduleInteractions(root, expirationTime, interactions) {
  if (!enableSchedulerTracing) {
    return;
  }

  if (interactions.size > 0) {
    const pendingInteractionMap = root.pendingInteractionMap;
    const pendingInteractions = pendingInteractionMap.get(expirationTime);
    if (pendingInteractions != null) {
      interactions.forEach(interaction => {
        if (!pendingInteractions.has(interaction)) {
          // Update the pending async work count for previously unscheduled interaction.
          interaction.__count++;
        }

        pendingInteractions.add(interaction);
      });
    } else {
      pendingInteractionMap.set(expirationTime, new Set(interactions));

      // Update the pending async work count for the current interactions.
      interactions.forEach(interaction => {
        interaction.__count++;
      });
    }

    const subscriber = __subscriberRef.current;
    if (subscriber !== null) {
      const threadID = computeThreadID(root, expirationTime);
      subscriber.onWorkScheduled(interactions, threadID);
    }
  }
}

function schedulePendingInteractions(root, expirationTime) {
  // This is called when work is scheduled on a root.
  // It associates the current interactions with the newly-scheduled expiration.
  // They will be restored when that expiration is later committed.
  if (!enableSchedulerTracing) {
    return;
  }

  scheduleInteractions(root, expirationTime, __interactionsRef.current);
}

function startWorkOnPendingInteractions(root, expirationTime) {
  // This is called when new work is started on a root.
  if (!enableSchedulerTracing) {
    return;
  }

  // Determine which interactions this batch of work currently includes, So that
  // we can accurately attribute time spent working on it, And so that cascading
  // work triggered during the render phase will be associated with it.
  const interactions: Set<Interaction> = new Set();
  root.pendingInteractionMap.forEach(
    (scheduledInteractions, scheduledExpirationTime) => {
      if (scheduledExpirationTime >= expirationTime) {
        scheduledInteractions.forEach(interaction =>
          interactions.add(interaction),
        );
      }
    },
  );

  // Store the current set of interactions on the FiberRoot for a few reasons:
  // We can re-use it in hot functions like renderRoot() without having to
  // recalculate it. We will also use it in commitWork() to pass to any Profiler
  // onRender() hooks. This also provides DevTools with a way to access it when
  // the onCommitRoot() hook is called.
  root.memoizedInteractions = interactions;

  if (interactions.size > 0) {
    const subscriber = __subscriberRef.current;
    if (subscriber !== null) {
      const threadID = computeThreadID(root, expirationTime);
      try {
        subscriber.onWorkStarted(interactions, threadID);
      } catch (error) {
        // If the subscriber throws, rethrow it in a separate task
        scheduleCallback(ImmediatePriority, () => {
          throw error;
        });
      }
    }
  }
}

function finishPendingInteractions(root, committedExpirationTime) {
  if (!enableSchedulerTracing) {
    return;
  }

  const earliestRemainingTimeAfterCommit = root.firstPendingTime;

  let subscriber;

  try {
    subscriber = __subscriberRef.current;
    if (subscriber !== null && root.memoizedInteractions.size > 0) {
      const threadID = computeThreadID(root, committedExpirationTime);
      subscriber.onWorkStopped(root.memoizedInteractions, threadID);
    }
  } catch (error) {
    // If the subscriber throws, rethrow it in a separate task
    scheduleCallback(ImmediatePriority, () => {
      throw error;
    });
  } finally {
    // Clear completed interactions from the pending Map.
    // Unless the render was suspended or cascading work was scheduled,
    // In which case– leave pending interactions until the subsequent render.
    const pendingInteractionMap = root.pendingInteractionMap;
    pendingInteractionMap.forEach(
      (scheduledInteractions, scheduledExpirationTime) => {
        // Only decrement the pending interaction count if we're done.
        // If there's still work at the current priority,
        // That indicates that we are waiting for suspense data.
        if (scheduledExpirationTime > earliestRemainingTimeAfterCommit) {
          pendingInteractionMap.delete(scheduledExpirationTime);

          scheduledInteractions.forEach(interaction => {
            interaction.__count--;

            if (subscriber !== null && interaction.__count === 0) {
              try {
                subscriber.onInteractionScheduledWorkCompleted(interaction);
              } catch (error) {
                // If the subscriber throws, rethrow it in a separate task
                scheduleCallback(ImmediatePriority, () => {
                  throw error;
                });
              }
            }
          });
        }
      },
    );
  }
}
