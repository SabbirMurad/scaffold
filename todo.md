# To do

## Design styles still missing

Each with how it would export to Flutter.

**Common in app UI**
- [ ] **Text truncation:** max lines plus an ellipsis ("…"), for titles and descriptions in cards and list rows. Now long text simply grows or wraps. Flutter: `maxLines` + `TextOverflow.ellipsis`.
- [ ] **Clip content:** a container's option to hide whatever overflows it, for images inside rounded cards and cropped layouts. Flutter: `clipBehavior`.

**Styling depth**
- [ ] **Image adjustments:** a color tint or overlay, grayscale, and opacity for photos, such as a dark overlay so text reads on a hero image. Flutter: `ColorFiltered`.
- [ ] **Sweep (angular) gradient:** for progress rings and color wheels, alongside the existing linear and radial ones. Flutter: `SweepGradient`.

**Layout constraints**
- [ ] **Min/max width and height,** such as a button that grows with its label but never past 280 px. Flutter: `ConstrainedBox`.
- [ ] **Aspect ratio lock,** such as 16:9 media that scales with the screen width. Flutter: `AspectRatio`.

**Bigger features**
- [ ] **Custom shapes:** only rectangles and circles can be drawn now. There are no lines, polygons, arrows or pen paths; icons come from SVG. A pen or shape tool is a much larger job than the rest.
- [ ] **Blend modes,** like multiply and screen. Rare in app UI; Flutter support is partial.
