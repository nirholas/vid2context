---
title: The web component and postMessage API
label: Web component and events
description: Use the vid2context-embed element and Vid2Context.embed(), listen for loaded, segment and seek events, and drive the widget with seek, search, theme and load commands over postMessage.
order: 2
---

`/embed.js` defines a `<vid2context-embed>` element. It puts the widget in an iframe from the same server the script came from, resizes it to its content, and turns the widget's messages into DOM events. It is a single small script with no dependencies.

## Try it

This is the element running on this page. The buttons call its methods, and every event it fires is logged under it.

```widget embed-component
```

## Attributes

Every [embed parameter](/docs/embed/parameters/) is an attribute with the same name, plus three that only the element has:

- `height`: a fixed height in pixels. Without it the element follows the widget's size.
- `max-height`: the tallest the element grows for the transcript and chapters views, which scroll inside it. Default 640.
- `loading`: `lazy` (the default) waits until the element is near the screen; `eager` loads at once.

Changing an attribute reloads the widget with the new options, except `theme`, which switches in place.

## Events

The element fires these as `CustomEvent`s that bubble, with the fields in `event.detail`:

{{embed.events}}

```js
const el = document.querySelector('vid2context-embed');
el.addEventListener('vid2context:loaded', (e) => {
  console.log(`${e.detail.title}: ${e.detail.segments} lines, ${e.detail.chapters} chapters`);
});
el.addEventListener('vid2context:segment', (e) => {
  // The reader clicked a line: send it to your own player, notes or chat box.
  console.log(e.detail.startSec, e.detail.text);
});
el.addEventListener('vid2context:error', (e) => console.warn(e.detail.code, e.detail.hint));
```

## Methods

- `el.seek(sec)`: scroll to the line at this time and highlight it. Takes seconds or a string like `"2:30"`. With `player="1"`, the video seeks too.
- `el.search(query)`: set the search box. An empty string clears it.
- `el.setTheme('auto' | 'light' | 'dark')`: same as setting the `theme` attribute.
- `el.load({ url })`, `el.load({ sample })` or `el.load({ src })`: show another video without rebuilding the element.

## From JavaScript

`Vid2Context.embed(target, options)` creates the element inside `target` (an element or a CSS selector) and returns it. Option names are the parameters; camelCase names become kebab-case attributes (`maxHeight` becomes `max-height`), and `true` and `false` become `1` and `0`.

```html
<div id="talk"></div>
<script src="https://vid2context.com/embed.js"></script>
<script>
  const widget = Vid2Context.embed('#talk', {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    theme: 'light',
    player: true,
    maxHeight: 520,
  });
  widget.addEventListener('vid2context:loaded', (e) => console.log(e.detail.title));
</script>
```

`Vid2Context.origin` is the server the script came from, and `Vid2Context.params` lists every parameter name.

## Without the script: postMessage

A plain iframe speaks the same protocol. The widget posts every event to its parent as an object with `source: "vid2context"` and a `type`; the fields are the ones in the table above.

```js
const frame = document.querySelector('iframe[src*="/embed/"]');
window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || e.origin !== 'https://vid2context.com') return;
  if (e.data?.source !== 'vid2context') return;
  if (e.data.type === 'resize') frame.style.height = `${Math.min(e.data.height, 640)}px`;
  if (e.data.type === 'segment') console.log(e.data.startSec, e.data.text);
});
```

To send a command, post an object with `target: "vid2context"` to the iframe:

{{embed.commands}}

```js
frame.contentWindow.postMessage({ target: 'vid2context', type: 'seek', sec: 75 }, 'https://vid2context.com');
frame.contentWindow.postMessage({ target: 'vid2context', type: 'search', query: 'engine' }, 'https://vid2context.com');
```

The widget only accepts commands from the page that embeds it (its `window.parent`), and it posts nothing it does not show: the messages carry the same public transcript the widget displays.
