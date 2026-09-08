(function(root){
  'use strict';
  root.StillHomeMediaActions={
    create:function(options){
      var active=null,overlay=null,panel,input,title,description,message,cancel,submit,origin;
      function element(tag,className,text){var el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
      function focusable(){return Array.prototype.slice.call(panel.querySelectorAll('button,input')).filter(function(el){return !el.disabled&&!el.hidden;});}
      function close(force){
        if(!active||active.saving&&!force)return;
        var key=active.id;active=null;overlay.hidden=true;
        if(options.closed)options.closed(key,origin);
        else if(origin&&origin.isConnected)origin.focus();
      }
      function build(){
        if(overlay)return;
        overlay=element('div','media-action-overlay');overlay.id='media-action-overlay';overlay.hidden=true;
        panel=element('section','media-action-panel');panel.id='media-action-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','media-action-title');
        title=element('h2');title.id='media-action-title';
        description=element('p');description.id='media-action-description';panel.setAttribute('aria-describedby',description.id);
        input=element('input');input.id='media-action-name';input.type='text';input.maxLength=120;input.autocomplete='off';input.setAttribute('aria-label','Wallpaper name');
        message=element('p','media-action-status');message.id='media-action-status';message.setAttribute('role','status');
        var actions=element('div','button-row media-action-buttons');
        cancel=element('button','media-action-cancel','Cancel');cancel.id='media-action-cancel';cancel.type='button';
        submit=element('button','media-action-submit');submit.id='media-action-submit';submit.type='button';
        [input,cancel,submit].forEach(function(el){el.setAttribute('data-focus','');el.setAttribute('data-focus-key',el.id);});
        cancel.addEventListener('click',function(){close(false);});submit.addEventListener('click',save);
        actions.append(cancel,submit);panel.append(title,description,input,message,actions);overlay.appendChild(panel);document.body.appendChild(overlay);
        overlay.addEventListener('keydown',function(event){
          if(options.keyboardVisible&&options.keyboardVisible())return;
          if(event.key==='Escape'||event.keyCode===461){event.preventDefault();event.stopPropagation();close(false);return;}
          if(event.key==='Tab'){event.preventDefault();event.stopPropagation();var items=focusable(),index=items.indexOf(document.activeElement);if(items.length)items[(index+(event.shiftKey?-1:1)+items.length)%items.length].focus();}
          if((event.key==='Enter'||event.keyCode===13)&&document.activeElement===input){event.preventDefault();event.stopPropagation();if(!event.repeat)save();}
        });
        document.addEventListener('click',function(event){if(active&&!panel.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();}},true);
        document.addEventListener('focusin',function(event){if(active&&!panel.contains(event.target)){var items=focusable();if(items.length)items[0].focus();}});
      }
      function open(mode,entry){
        if(active||!entry||entry.id==='default'||options.busy&&options.busy())return;
        build();origin=document.activeElement;
        active={mode:mode,id:entry.id,revision:options.revision(),saving:false};
        var rename=mode==='rename';title.textContent=rename?'Rename wallpaper':'Delete wallpaper?';
        description.textContent=rename?'Choose the name shown in your wallpaper library. The original file is not renamed.':'Permanently delete “'+entry.name+'” from this TV? If it is in use, the included photo will be shown. Originals on your phone or computer are kept.';
        input.hidden=!rename;input.value=entry.name;message.textContent='';submit.textContent=rename?'Save name':'Delete wallpaper';submit.classList.toggle('is-danger',!rename);
        input.disabled=false;cancel.disabled=false;submit.disabled=false;overlay.hidden=false;
        if(options.opened)options.opened();
        if(rename){input.focus();input.select();}else cancel.focus();
      }
      function save(){
        var action=active;if(!action||action.saving)return;
        var name=input.value.trim();
        if(action.mode==='rename'&&(!name||name.length>120||/[\x00-\x1f\x7f]/.test(name))){message.textContent='Use a name between 1 and 120 characters.';input.focus();return;}
        action.saving=true;cancel.disabled=true;submit.disabled=true;input.disabled=true;message.textContent=action.mode==='rename'?'Saving name…':'Deleting wallpaper…';
        var body={id:action.id,revision:action.revision};if(action.mode==='rename')body.name=name;
        options.request('/api/wallpapers/'+action.mode,{method:'POST',body:body}).then(function(data){
          if(active!==action)return;
          options.config(data.config,true);action.saving=false;close(false);
          if(options.notify)options.notify(action.mode==='rename'?'Wallpaper renamed.':'Wallpaper deleted from this TV. Originals on other devices are unchanged.');
        }).catch(function(error){
          if(active!==action)return;
          var config=error.config||(error.body&&error.body.config);
          if(config){options.config(config,false);action.revision=config.revision;var latest=(config.wallpaperLibrary||[]).find(function(entry){return entry.id===action.id;});if(latest&&action.mode==='delete')description.textContent='Permanently delete “'+latest.name+'” from this TV? If it is in use, the included photo will be shown. Originals elsewhere are kept.';}
          action.saving=false;cancel.disabled=false;submit.disabled=false;input.disabled=false;
          message.textContent=(error.status===409?'The library changed. Review your choice, then try again. ': '')+(error.message||'Could not finish. Try again.');
          if(error.status===404){submit.disabled=true;message.textContent='This wallpaper was already removed. Close this dialog and refresh the library.';}
          if(error.status>=500&&action.mode==='delete')message.textContent='Deletion could not finish. Retry to finish removing this wallpaper; it may already be removed from the list.';
          cancel.focus();
        });
      }
      return {open:open,cancel:function(){close(false);},close:function(){close(true);},isOpen:function(){return !!active;},scope:function(){return panel;}};
    }
  };
}(window));
