# Flow 075 — layout shrink fix

When the transcript overflowed and a scrollbar appeared, the composer collapsed: flexbox default flexShrink:1 let the chrome shrink and the ScrollBox min-height:auto pushed it. Fix: flexShrink:0 on header/menu/composer/footer, minHeight:0 on the ScrollBox, minWidth:0 on main, flexShrink:0 on sidebar.
