function fadeElement(element: HTMLElement, init_opacity: number, final_opacity: number, remove: boolean, duration: number) {
  var op = init_opacity;  // initial opacity
  const timeInterval = 10; // in ms
  var decrement = (init_opacity - final_opacity) * timeInterval / duration;
  var timer = setInterval(function () {
    if (op <= final_opacity) {
      element.style.opacity = final_opacity.toString();
      element.style.filter = 'alpha(opacity=' + final_opacity * 100 + ")";
      clearInterval(timer);
      if (remove) {
        element.style.display = 'none';
      }
    }
    element.style.opacity = op.toString();
    element.style.filter = 'alpha(opacity=' + op * 100 + ")";
    op -= decrement;
  }, timeInterval);
}

function displayElement(element: HTMLElement, init_opacity: number, final_opacity: number, removed: boolean, duration: number) {
  var op = init_opacity;  // initial opacity
  const timeInterval = 10; // in ms
  var increment = (final_opacity - init_opacity) * timeInterval / duration;
  if (removed) {
    element.style.display = 'block';
  }
  var timer = setInterval(function () {
    if (op >= final_opacity) {
      element.style.opacity = final_opacity.toString();
      element.style.filter = 'alpha(opacity=' + final_opacity * 100 + ")";
      clearInterval(timer);
    }
    element.style.opacity = op.toString();
    element.style.filter = 'alpha(opacity=' + op * 100 + ")";
    op += increment;
  }, timeInterval);
}


function fadeBackGround(element: HTMLElement, init_opacity: number, final_opacity: number, remove: boolean, duration: number) {
  var op = init_opacity;  // initial opacity

  // initial rgb
  const bgColor = window.getComputedStyle(element).backgroundColor;
  const rgbRegex = /rgb\((\d+), (\d+), (\d+)\)/;
  const match = rgbRegex.exec(bgColor);
  if (match == null) {
    return;
  }
  const r = match[1];
  const g = match[2];
  const b = match[3];

  const timeInterval = 2; //in ms
  var decrement = (init_opacity - final_opacity) * timeInterval / duration;
  var timer = setInterval(function () {
    if (op <= final_opacity) {
      element.style.background = 'rgba(' + r + ', ' + g + ', ' + b + ', ' + final_opacity + ')';
      clearInterval(timer);
      if (remove) {
        element.style.display = 'none';
      }
    }
    element.style.background = 'rgba(' + r + ', ' + g + ', ' + b + ', ' + op + ')';
    op -= decrement;
  }, timeInterval);
}


export { fadeElement, fadeBackGround, displayElement }