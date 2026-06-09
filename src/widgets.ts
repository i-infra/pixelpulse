export interface NumberWidgetOptions {
  valuefn: (arg: unknown) => number;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits: number;
  changedfn: (v: number) => void;
}

export interface NumberWidget {
  el: HTMLSpanElement;
  set: (arg: unknown) => void;
}

export function numberWidget(
  opts: NumberWidgetOptions, title: string, cssClass?: string,
): NumberWidget {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.addEventListener('change', () => {
    opts.changedfn(parseFloat(input.value));
  });

  const span = document.createElement('span');
  span.appendChild(input);
  span.appendChild(document.createTextNode(opts.unit));
  span.title = title;
  if (cssClass) span.className = cssClass;

  return {
    el: span,
    set(arg: unknown) {
      input.value = opts.valuefn(arg).toFixed(opts.digits);
    },
  };
}

export interface SelectDropdownOptions {
  options: string[];
  selectedOption?: string;
  showText: boolean;
  changed: (option: string) => void;
}

export interface SelectDropdown {
  el: HTMLDivElement;
  select: (option: string) => void;
  hideDropdown: () => void;
}

export function selectDropdown(opts: SelectDropdownOptions): SelectDropdown {
  let dropdown: HTMLUListElement | null = null;
  let selectedOption = opts.selectedOption;

  const el = document.createElement('div');
  el.className = 'select-dropdown';

  if (opts.showText) {
    el.classList.add('text-dropdown');
  } else {
    el.classList.add('icon-dropdown');
  }

  const iconFor = (option: string) => `icon-${option.toLowerCase()}`;

  function select(option: string) {
    if (opts.showText) el.textContent = option;
    if (selectedOption) el.classList.remove(iconFor(selectedOption));
    el.classList.add(iconFor(option));
    selectedOption = option;
  }

  function hideDropdown() {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
  }

  function showDropdown() {
    const onBodyClick = () => hideDropdown();
    document.body.addEventListener('click', onBodyClick, { once: true });

    dropdown = document.createElement('ul');
    for (const option of opts.options) {
      const li = document.createElement('li');
      li.textContent = option;
      li.className = iconFor(option);
      li.addEventListener('click', () => {
        select(option);
        opts.changed(option);
      });
      dropdown.appendChild(li);
    }
    el.appendChild(dropdown);
  }

  el.addEventListener('click', (e) => {
    if (!dropdown && e.target === el) {
      showDropdown();
      e.stopPropagation();
    }
  });

  if (selectedOption) select(selectedOption);

  return { el, select, hideDropdown };
}

export function btnPopup(
  button: HTMLElement, popup: HTMLElement,
  opencb: () => void, closecb?: () => void,
): void {
  let state = false;

  function hidePopup() {
    popup.style.display = 'none';
    button.classList.remove('active');
    state = false;
    closecb?.();
  }

  function showPopup() {
    popup.style.display = 'block';
    popup.style.left = `${button.offsetLeft}px`;
    popup.style.bottom = '42px';
    document.addEventListener('click', hidePopup, { once: true });
    button.classList.add('active');
    state = true;
  }

  button.addEventListener('click', (e) => {
    if (!state) {
      opencb();
      document.dispatchEvent(new Event('click')); // close others
      showPopup();
      e.stopPropagation();
    }
  });

  popup.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}
