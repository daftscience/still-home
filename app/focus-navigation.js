(function (root) {
  'use strict';
  function visible(el) { return !el.disabled && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0; }
  function controls(scope) { return Array.prototype.slice.call(scope.querySelectorAll('[data-focus]')).filter(visible); }
  function scalar(el) { var row=el.closest('.dim-controls'); return row && row.querySelector('input[type="range"]'); }
  function rows(scope) {
    var result=[], owners=[];
    controls(scope).forEach(function(el) {
      var slider=scalar(el); if(slider && el!==slider)return;
      var grid=el.closest('.available-apps');
      var owner=el.closest('.selected-row,.library-row,.remembered-phone,.apps-actions,.button-row,.search-form,.segmented,.dim-controls,.focal-actions,.focal-header');
      if(grid) {
        var items=controls(grid),columns=getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length;
        var rowIndex=Math.floor(items.indexOf(el)/Math.max(1,columns));
        owner=grid.id+':'+rowIndex;
      }
      owner=owner||el;
      var index=owners.indexOf(owner);
      if(index<0){owners.push(owner);result.push([]);index=result.length-1;}
      result[index].push(el);
    });
    return result;
  }
  function next(groups,current,direction) {
    var row=-1,col=-1;
    groups.some(function(group,index){col=group.indexOf(current);if(col>=0){row=index;return true;}return false;});
    if(row<0)return groups.length?groups[0][0]:null;
    if(direction==='left'||direction==='right')return groups[row][col+(direction==='left'?-1:1)]||current;
    var target=groups[row+(direction==='up'?-1:1)];
    if(!target)return current;
    // Preserve the named action column when disabled controls are omitted.
    var match=/^(wallpaper-(?:use|focal|rename|delete)|up|down|remove)-/.exec(current.getAttribute('data-focus-key')||'');
    return (match&&target.find(function(el){return (el.getAttribute('data-focus-key')||'').indexOf(match[0])===0;}))||target[Math.min(col,target.length-1)];
  }
  root.StillHomeNavigation={visible:visible,controls:controls,scalar:scalar,rows:rows,next:next};
}(typeof window==='undefined'?globalThis:window));
