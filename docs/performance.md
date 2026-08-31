# Performance validation

Performance claims for this package are hardware-qualified. Mock GL tests prove
pass counts, upload/readback behavior and resource lifetime; they do not measure
a phone GPU, RenderThread or compositor.

## Reference workloads

Run both deterministic Atlas fixtures:

- web parity: 900 points / 2,600 links;
- mobile ceiling: 2,000 points / 6,000 links.

For each fixture capture labels off, `renderMode="overlay"`, and
`renderMode="inline"` while the simulation runs, while panning/zooming after it
settles, and with 140 selected labels. Warm for five seconds, capture 30 seconds,
repeat three times, and report the median run. Keep the display refresh mode
fixed, disable remote JS debugging, and let the phone return to a stable thermal
state between groups.

The 90Hz release gate is:

- median FPS at least 90;
- p95 no more than 11.1ms and p99 no more than 22.2ms;
- labels-on p95 no more than 15% above labels-off in the same workload;
- zero label refreshes, readbacks, uploads and scheduled graph frames at idle;
- one inline label draw and zero readbacks in ordinary render frames;
- policy/collision readbacks coalesced to at most 10Hz during motion;
- a 2048² R8 atlas (4MiB) with patch-only uploads after warm-up.

Do not add an unqualified result to the README. Record device model, OS, build
type, refresh rate, point/link counts, label mode/count, DPR, all frame
percentiles, and the profiler's readback/upload counters.

## Android trace

Use a development client and capture Android Perfetto FrameTimeline together
with graphics, RenderThread and SurfaceFlinger/GPU tracks. The in-app profiler
measures frames submitted by the graph and host call duration; it cannot prove
where the driver or transparent-surface composition spent time.

When `EXT_disjoint_timer_query_webgl2` is available, performance observers also
receive asynchronous, non-disjoint `gpuMs` samples. They are intentionally
sparse—only one query can be pending—and are omitted rather than blocking when
the result is not ready. Perfetto remains the source of truth for RenderThread,
GPU scheduling and SurfaceFlinger composition.

Compare the web Atlas on the same handset with Chrome remote profiling. Record
its actual graph size, DPR, canvas backing dimensions and live label count; the
web product's 900/2,600 cap is not comparable to a 2,000/6,000 mobile run unless
both figures are stated. The current web view also includes cluster labels,
while the mobile performance fixture deliberately does not add them.
